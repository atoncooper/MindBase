"""Top-level lifecycle orchestrator for all agents.

``AgentLifecycleManager`` provides a single entry point for invoking any
registered agent.  Behind the scenes it manages:

* Session lifecycle (creation, heartbeat, expiry)
* Concurrency control (per-session ``asyncio.Lock``)
* Agent instance pooling (avoid re-compiling graphs)
* Circuit-breaking (global failure threshold)
* Observability hooks (invoke start/end/error)

Usage::

    from app.agent.lifecycle import AgentLifecycleManager
    from app.agent.memory import build_memory_agent

    manager = AgentLifecycleManager()

    # Register the memory agent's factory
    manager.register(
        "memory",
        build_memory_agent,
        context_manager=ctx_mgr,
        llm=llm,
    )

    # Invoke through the lifecycle layer
    result = await manager.invoke("memory", session_id="abc", query="...")

    # Graceful shutdown
    await manager.shutdown()
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable

from app.agent.lifecycle.circuit import CircuitBreaker
from app.agent.lifecycle.hooks import LifecycleHookRegistry
from app.agent.lifecycle.pool import AgentPool
from app.agent.lifecycle.session import SessionManager

logger = logging.getLogger(__name__)

# ── types ─────────────────────────────────────────────────────────────

AgentFactory = Callable[..., Any]
"""Signature: ``(**kwargs) -> CompiledLangGraph``."""


class AgentLifecycleManager:
    """Unified lifecycle manager for all agents.

    Thread-safe for async use (single-threaded event loop).
    """

    def __init__(self) -> None:
        # components
        self._sessions = SessionManager()
        self._pool = AgentPool()
        self._hooks = LifecycleHookRegistry()
        self._circuit_breaker = CircuitBreaker(name="global")

        # registered agent factories: {name: (factory, kwargs)}
        self._factories: dict[str, tuple[AgentFactory, dict]] = {}
        self._closed = False

    # ── properties ────────────────────────────────────────────────────

    @property
    def sessions(self) -> SessionManager:
        return self._sessions

    @property
    def pool(self) -> AgentPool:
        return self._pool

    @property
    def hooks(self) -> LifecycleHookRegistry:
        return self._hooks

    @property
    def circuit(self) -> CircuitBreaker:
        return self._circuit_breaker

    @property
    def registered_agents(self) -> list[str]:
        """Names of all registered agent types."""
        return list(self._factories.keys())

    # ── registration ──────────────────────────────────────────────────

    def register(
        self,
        name: str,
        factory: AgentFactory,
        **factory_kwargs: Any,
    ) -> None:
        """Register an agent type with its build factory.

        Args:
            name: Agent type name (e.g. ``"memory"``, ``"chat"``).
            factory: Callable that returns a compiled LangGraph.
            **factory_kwargs: Extra args passed to *factory* each time
                a new instance is needed.
        """
        if name in self._factories:
            logger.warning("[LIFECYCLE] re-registering agent '{}'", name)
        self._factories[name] = (factory, factory_kwargs)
        logger.info("[LIFECYCLE] registered agent '{}'", name)

    # ── invoke ────────────────────────────────────────────────────────

    async def invoke(
        self,
        agent_name: str,
        session_id: str,
        timeout: float | None = 60.0,
        **input: Any,
    ) -> dict[str, Any]:
        """Execute an agent with full lifecycle management.

        1. Check circuit breaker
        2. Acquire per-session lock
        3. Get or create session
        4. Get or create agent instance (pooled)
        5. Emit ``on_invoke_start`` hook
        6. Run ``agent.ainvoke(input)`` with optional timeout
        7. Emit ``on_invoke_end`` / ``on_invoke_error`` hook
        8. Touch session heartbeat
        9. Record success/failure on circuit breaker

        Args:
            agent_name: Registered agent type name.
            session_id: Chat or task session identifier.
            timeout: Max seconds for the invocation (None = no timeout).
            **input: Keyword args passed to ``agent.ainvoke()``.

        Returns:
            The agent's output dict.

        Raises:
            ValueError: *agent_name* is not registered.
            RuntimeError: Manager is shut down.
        """
        if self._closed:
            raise RuntimeError("AgentLifecycleManager is shut down")

        # 1. Circuit breaker guard
        if self._circuit_breaker.is_tripped:
            logger.warning(
                "[LIFECYCLE] circuit breaker open, rejecting {}/{}",
                agent_name,
                session_id,
            )
            return {"error": "service temporarily unavailable"}

        # 2. Per-session concurrency lock
        async with self._sessions.acquire_lock(session_id):
            start = time.monotonic()

            # 3. Ensure session exists
            self._sessions.get_or_create(session_id)

            try:
                # 4. Pool: get or create agent instance
                agent = await self._acquire_agent(agent_name, session_id)

                # 5. Hook: invoke start
                self._hooks.on_invoke_start(session_id, agent_name, **input)

                # 6. Execute with optional timeout + LangSmith tracing config
                run_config = {
                    "run_name": f"{agent_name}_agent",
                    "tags": [agent_name, "agent"],
                    "metadata": {
                        "agent_name": agent_name,
                        "session_id": session_id,
                    },
                }

                if timeout is not None:
                    result = await asyncio.wait_for(
                        agent.ainvoke(input, config=run_config),
                        timeout=timeout,
                    )
                else:
                    result = await agent.ainvoke(input, config=run_config)

                # Ensure result is a dict
                if not isinstance(result, dict):
                    result = {"result": result}

                # 7a. Hook: invoke end
                elapsed = (time.monotonic() - start) * 1000
                self._hooks.on_invoke_end(session_id, agent_name, elapsed)

                # 8. Touch session heartbeat
                self._sessions.touch(session_id)

                # 9. Record success on circuit breaker
                self._circuit_breaker.record_success()

                return result

            except asyncio.CancelledError:
                raise
            except asyncio.TimeoutError:
                self._circuit_breaker.record_failure()
                raise
            except Exception as exc:
                elapsed = (time.monotonic() - start) * 1000
                error_msg = str(exc)

                # 7b. Hook: invoke error
                self._hooks.on_invoke_error(session_id, agent_name, error_msg)

                # 9. Record failure on circuit breaker
                self._circuit_breaker.record_failure()

                logger.error(
                    "[LIFECYCLE] {}/{} failed after {:.0f}ms: {}",
                    agent_name,
                    session_id,
                    elapsed,
                    error_msg,
                )
                return {"error": error_msg}

    # ── internal ──────────────────────────────────────────────────────

    async def _acquire_agent(self, agent_name: str, session_id: str) -> Any:
        """Get a cached agent instance, creating one if needed."""
        if agent_name not in self._factories:
            raise ValueError(f"unknown agent '{agent_name}' — did you call register()?")

        factory, kwargs = self._factories[agent_name]

        def _build():
            return factory(**kwargs)

        return self._pool.acquire(agent_name, session_id, _build)

    async def get_agent(self, agent_name: str, session_id: str) -> Any:
        """Public accessor for a pooled agent instance (for streaming)."""
        if self._closed:
            raise RuntimeError("AgentLifecycleManager is shut down")
        return await self._acquire_agent(agent_name, session_id)

    # ── lifecycle ─────────────────────────────────────────────────────

    async def cleanup(self, ttl_seconds: float = 300.0) -> int:
        """Clean up expired sessions.

        Returns the number of sessions cleaned.
        """
        cleaned = await self._sessions.cleanup_expired(ttl_seconds)
        for sid in self._sessions.active_session_ids:
            if self._sessions.is_expired(sid, ttl_seconds):
                self._pool.release_session(sid)
                self._hooks.on_session_expired(sid)
        return cleaned

    async def shutdown(self) -> None:
        """Graceful shutdown — release all resources."""
        if self._closed:
            return
        self._closed = True
        self._pool.release_all()
        self._sessions.destroy_all()
        self._circuit_breaker.reset()
        logger.info("[LIFECYCLE] shutdown complete")

    async def health(self) -> dict[str, Any]:
        """Return health status for monitoring."""
        return {
            "status": "shutdown" if self._closed else "running",
            "sessions_active": self._sessions.active_count,
            "pool_size": self._pool.size,
            "circuit_breaker": {
                "state": self._circuit_breaker.state.value,
                "failures": self._circuit_breaker.failure_count,
            },
            "registered_agents": list(self._factories.keys()),
        }
