"""AgentHarness — wires the agent system into the FastAPI application.

Creates the ``ToolRegistry``, ``AgentRuntime``, registers all available
tools, and injects the runtime into agent factories.

Both the **Chat Agent** and **Memory Agent** are registered.  All tools
(shared context tools + chat-specific tools) live in the same
``ToolRegistry`` so both agents can use them.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from app.agent.lifecycle import AgentLifecycleManager
from app.context import ContextManager
from app.harness.orchestrator import AgentOrchestrator
from app.harness.runtime import AgentRuntime
from app.harness.scheduling.agent import AgentConfig, AgentScheduler
from app.skills import SkillManager
from app.tools import ToolDeps, ToolManager, ToolRegistry

logger = logging.getLogger(__name__)

CLEANUP_INTERVAL = 120
SESSION_TTL = 600


class AgentHarness:
    """Integration harness — wires agents into the app.

    Creates the ``ToolRegistry``, ``AgentRuntime``, registers tools, and
    provides a single ``invoke()`` entry point for all registered agents.

    Usage in ``main.py`` startup::

        from app.harness import AgentHarness
        from app.context import init_context_manager
        from langchain_openai import ChatOpenAI

        ctx_mgr = init_context_manager()
        llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

        harness = AgentHarness(
            context_manager=ctx_mgr,
            llm=llm,
            session_factory=get_db_session,
        )
        await harness.start()
        app.state.agent_harness = harness

    Then anywhere in request handling::

        result = await request.app.state.agent_harness.invoke(
            "chat", session_id="abc", query="...", uid=1,
        )

    On shutdown::

        await harness.shutdown()
    """

    def __init__(
        self,
        *,
        context_manager: ContextManager,
        llm: Any,
        session_factory: Any | None = None,
        cleanup_interval: float = CLEANUP_INTERVAL,
        session_ttl: float = SESSION_TTL,
        agent_configs: dict[str, AgentConfig] | None = None,
    ) -> None:
        self._ctx_mgr = context_manager
        self._llm = llm
        self._session_factory = session_factory
        self._cleanup_interval = cleanup_interval
        self._session_ttl = session_ttl
        self._agent_configs = agent_configs or {}

        self._registry = ToolRegistry()
        self._runtime = AgentRuntime(self._registry)
        self._lifecycle = AgentLifecycleManager()
        self._orchestrator = AgentOrchestrator(llm=llm)
        self._scheduler = AgentScheduler(self._lifecycle)
        self._skill_manager = SkillManager(session_factory)
        self._tool_manager: ToolManager | None = None
        self._cleanup_task: asyncio.Task | None = None
        self._started = False

    @property
    def lifecycle(self) -> AgentLifecycleManager:
        return self._lifecycle

    @property
    def orchestrator(self) -> AgentOrchestrator:
        return self._orchestrator

    @property
    def runtime(self) -> AgentRuntime:
        return self._runtime

    @property
    def scheduler(self) -> AgentScheduler:
        return self._scheduler

    @property
    def skill_manager(self) -> SkillManager:
        return self._skill_manager

    @property
    def tool_registry(self) -> ToolRegistry:
        """Registered tool instances.  Use ``runtime.execute()`` to invoke."""
        return self._registry

    @property
    def tool_names(self) -> list[str]:
        """Names of all registered tools."""
        return self._registry.list()

    @property
    def tool_manager(self) -> ToolManager | None:
        """Tool discovery manager (None until ``start()`` runs)."""
        return self._tool_manager

    @property
    def started(self) -> bool:
        return self._started

    # ── lifecycle ─────────────────────────────────────────────────────

    async def start(self) -> None:
        """Register tools, start runtime, register agents, start scheduler."""
        if self._started:
            return

        self._register_tools()
        await self._runtime.start()
        self._register_agents()

        # Configure and start scheduler
        for agent_name, config in self._agent_configs.items():
            self._scheduler.set_config(agent_name, config)
        await self._scheduler.start()

        self._cleanup_task = asyncio.create_task(self._cleanup_loop())
        self._started = True

        logger.info(
            "[HARNESS] started tools=%s agents=%s schedulers=%s",
            len(self._registry.list()),
            self._lifecycle.registered_agents,
            list(self._agent_configs.keys()),
        )

    async def shutdown(self) -> None:
        """Graceful shutdown — stop scheduler, runtime, lifecycle."""
        if not self._started:
            return

        if self._cleanup_task is not None:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None

        await self._scheduler.shutdown()
        await self._runtime.stop()
        await self._lifecycle.shutdown()
        self._started = False
        logger.info("[HARNESS] shutdown complete")

    async def _cleanup_loop(self) -> None:
        """Periodically clean up expired sessions and release pooled agents."""
        try:
            while True:
                await asyncio.sleep(self._cleanup_interval)
                try:
                    cleaned = await self._lifecycle.cleanup(
                        ttl_seconds=self._session_ttl,
                    )
                    if cleaned:
                        logger.info(
                            "[HARNESS] cleanup removed %s expired sessions", cleaned
                        )
                except Exception:
                    logger.exception("[HARNESS] cleanup error")
        except asyncio.CancelledError:
            pass

    # ── invoke ────────────────────────────────────────────────────────

    async def invoke(
        self,
        agent_name: str,
        session_id: str,
        timeout: float | None = 60.0,
        bypass_scheduler: bool = True,
        **input: Any,
    ) -> dict[str, Any]:
        """Invoke a registered agent.

        Args:
            agent_name: Registered agent type (``"chat"`` or ``"memory"``).
            session_id: Session identifier.
            timeout: Max invocation seconds.
            bypass_scheduler: When True (default), goes directly to
                ``AgentLifecycleManager``, bypassing queues and concurrency
                limits.  Set to False to route through the scheduler.
            **input: Agent input kwargs.

        Returns:
            Agent output dict.
        """
        if bypass_scheduler:
            return await self._lifecycle.invoke(
                agent_name,
                session_id,
                timeout=timeout,
                **input,
            )
        return await self._scheduler.invoke(
            agent_name,
            session_id,
            timeout=timeout,
            **input,
        )

    # ── dispatch (auto-route via orchestrator) ────────────────────────

    async def dispatch(
        self,
        session_id: str,
        *,
        query: str,
        timeout: float | None = 60.0,
        bypass_scheduler: bool = True,
        callbacks: Optional[list[Any]] = None,
        **input: Any,
    ) -> dict[str, Any]:
        """Auto-route to the best agent, then invoke it.

        Uses ``AgentOrchestrator.route()`` to decide which agent handles
        the query, then delegates to ``invoke()``.

        Args:
            session_id: Session identifier.
            query: User question (used for routing).
            timeout: Max invocation seconds.
            bypass_scheduler: Same as ``invoke()``.
            **input: Agent input kwargs (uid, bvids, etc.).

        Returns:
            Agent output dict.
        """
        uid = input.get("uid")
        route_input = {k: v for k, v in input.items() if k != "uid"}
        agent_name = await self._orchestrator.route(query, uid=uid, **route_input)
        logger.info(
            "[HARNESS] dispatch: query='%s' → agent='%s'",
            query[:60],
            agent_name,
        )
        return await self.invoke(
            agent_name,
            session_id,
            timeout=timeout,
            bypass_scheduler=bypass_scheduler,
            callbacks=callbacks,
            **input,
        )

    async def dispatch_stream(
        self,
        session_id: str,
        *,
        query: str,
        **input: Any,
    ) -> tuple[str, Any]:
        """Auto-route, then return (agent_name, graph) for streaming.

        Callers should use the returned graph to set up their own
        ``astream_events()`` loop.

        Args:
            session_id: Session identifier.
            query: User question (used for routing).
            **input: Agent input kwargs (uid, bvids, etc.).

        Returns:
            ``(agent_name, compiled_graph)`` tuple.
        """
        uid = input.get("uid")
        route_input = {k: v for k, v in input.items() if k != "uid"}
        agent_name = await self._orchestrator.route(query, uid=uid, **route_input)
        logger.info(
            "[HARNESS] dispatch_stream: query='%s' → agent='%s'",
            query[:60],
            agent_name,
        )
        agent_graph = await self._lifecycle.get_agent(agent_name, session_id)
        return agent_name, agent_graph

    # ── health ────────────────────────────────────────────────────────

    async def health(self) -> dict[str, Any]:
        base = await self._lifecycle.health()
        base["harness_started"] = self._started
        base["runtime"] = self._runtime.monitor()
        base["scheduler"] = self._scheduler.stats()
        base["tools"] = (
            self._tool_manager.summary()
            if self._tool_manager is not None
            else {"discovered": False}
        )
        return base

    # ── internal ──────────────────────────────────────────────────────

    def _register_tools(self) -> None:
        """Discover and register all tools via ``ToolManager``.

        Tools self-register via ``@register_tool`` and declare their own
        dependency requirements through a ``from_deps`` classmethod.
        Failures are recorded but never abort startup — see
        ``ToolManager.report()`` and ``health()['tools']`` for diagnostics.
        """
        db_deps: Any = None
        if self._session_factory is not None:
            from app.agent.chat.db_deps import DBChatDeps

            db_deps = DBChatDeps(self._session_factory)

        rag: Any = None
        try:
            from app.services.rag import get_rag_service

            rag = get_rag_service()
        except Exception:
            logger.exception("[HARNESS] failed to acquire RAG service")

        deps = ToolDeps(
            rag=rag,
            ctx_mgr=self._ctx_mgr,
            llm=self._llm,
            db_deps=db_deps,
            lifecycle=self._lifecycle,
            skill_manager=self._skill_manager,
        )

        manager = ToolManager(deps)
        manager.discover()

        for tool in manager.tools:
            self._registry.register(tool)

        self._tool_manager = manager

        logger.info(manager.report())
        if manager.failed():
            logger.error(
                "[HARNESS] %s tool(s) failed to load: %s",
                len(manager.failed()),
                [r.name for r in manager.failed()],
            )

    def _register_agents(self) -> None:
        """Register all agents with the lifecycle manager."""
        from app.agent.memory import build_memory_agent
        from app.agent.quiz import build_quiz_agent

        # ── Memory Agent (sub-agent, not top-level route target) ─────
        self._lifecycle.register(
            "memory",
            build_memory_agent,
            runtime=self._runtime,
            llm=self._llm,
            circuit_breaker=self._lifecycle.circuit,
        )
        # Not registered with orchestrator — called via delegate_to_agent tool
        logger.info("[HARNESS] registered agent 'memory' (sub-agent)")

        # ── Quiz Agent (lifecycle-managed, not a chat route target) ───
        self._lifecycle.register(
            "quiz",
            build_quiz_agent,
            llm=self._llm,
            circuit_breaker=self._lifecycle.circuit,
        )
        logger.info("[HARNESS] registered agent 'quiz'")

        # ── Chat Agent ───────────────────────────────────────────────
        if self._session_factory:
            from app.agent.chat import build_chat_agent
            from app.agent.chat.db_deps import DBChatDeps

            deps = DBChatDeps(self._session_factory)
            self._lifecycle.register(
                "chat",
                build_chat_agent,
                runtime=self._runtime,
                llm=self._llm,
                deps=deps,
                circuit_breaker=self._lifecycle.circuit,
                skill_manager=self._skill_manager,
            )
            self._orchestrator.register(
                "chat",
                "收藏夹知识库助手。使用ReAct模式回答用户关于B站视频内容和云盘文档的问题。"
                "支持向量检索、视频列表、视频总结等工具。"
                "适用于绝大多数用户问答场景。",
                default=True,
            )
            logger.info("[HARNESS] registered agent 'chat'")
        else:
            logger.warning(
                "[HARNESS] no session_factory provided — "
                "Chat Agent will not be registered"
            )
