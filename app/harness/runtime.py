"""AgentRuntime — executes tools on behalf of agents.

The agent graph never calls tools directly.  When the LLM emits
``tool_calls``, the graph's ``runtime_dispatch`` node hands them to
``AgentRuntime.execute()``, which:

* Looks up each tool by name in the ``ToolRegistry``.
* Runs all tools concurrently via ``asyncio.gather``.
* Records per-tool metrics (call count, duration, errors).
* Returns ``ToolMessage`` results back to the graph.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import ToolMessage
from langchain_core.tools import StructuredTool

from app.tools.registry import ToolRegistry

logger = logging.getLogger(__name__)


# ── metrics ────────────────────────────────────────────────────────────


@dataclass
class ToolMetrics:
    """Per-tool runtime statistics."""

    call_count: int = 0
    total_duration_ms: float = 0.0
    error_count: int = 0
    last_error: str | None = None
    last_called_at: float | None = None


# ── runtime ────────────────────────────────────────────────────────────


class AgentRuntime:
    """Executes tools for agents.  Created and owned by ``AgentHarness``.

    Usage::

        runtime = AgentRuntime(registry)
        await runtime.start()

        # Provide tool defs for LLM bind_tools:
        llm.bind_tools(runtime.list_tool_defs())

        # Execute when the LLM calls a tool:
        tool_messages = await runtime.execute(tool_calls)

        # Monitor:
        status = runtime.monitor()
    """

    def __init__(self, registry: ToolRegistry) -> None:
        self._registry = registry
        self._metrics: dict[str, ToolMetrics] = {}
        self._started = False
        self._tool_defs_cache: list[StructuredTool] | None = None

    # ── lifecycle ─────────────────────────────────────────────────────

    async def start(self) -> None:
        """Mark runtime as ready.  Validates all registered tools."""
        tool_names = self._registry.list()
        self._metrics = {name: ToolMetrics() for name in tool_names}
        self._started = True
        logger.info("[RUNTIME] started with %s tools: %s", len(tool_names), tool_names)

    async def stop(self) -> None:
        """Stop the runtime and log final metrics summary."""
        self._started = False
        total_calls = sum(m.call_count for m in self._metrics.values())
        total_errors = sum(m.error_count for m in self._metrics.values())
        logger.info(
            "[RUNTIME] stopped — total_calls=%s total_errors=%s tools=%s",
            total_calls,
            total_errors,
            len(self._metrics),
        )

    @property
    def started(self) -> bool:
        return self._started

    # ── bridge for agent graph ────────────────────────────────────────

    def list_tool_defs(self) -> list[StructuredTool]:
        """Return LangChain-compatible tool definitions for ``bind_tools()``.

        Cache and reuse — the tool definitions don't change at runtime.
        """
        if self._tool_defs_cache is None:
            self._tool_defs_cache = self._registry.for_agent()
        return self._tool_defs_cache

    def list_tool_names(self) -> list[str]:
        """Return names of all registered tools."""
        return self._registry.list()

    # ── execution ─────────────────────────────────────────────────────

    async def execute(
        self,
        tool_calls: list[dict],
        *,
        config: dict[str, Any] | None = None,
    ) -> list[ToolMessage]:
        """Execute multiple tool calls concurrently.

        Each *tool_call* dict must have ``id``, ``name``, ``args`` keys
        (standard LangChain AIMessage ``tool_calls`` format).

        Args:
            tool_calls: List of tool_call dicts from the LLM response.
            config: Optional LangSmith tracing config (run_name, tags, metadata).

        Returns:
            List of ``ToolMessage`` with matching ``tool_call_id``.

        Raises:
            RuntimeError: If the runtime has not been started.
        """
        if not tool_calls:
            return []
        if not self._started:
            raise RuntimeError("AgentRuntime is not started — call start() first")

        tasks = [self._execute_one(tc, config=config) for tc in tool_calls]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        tool_messages: list[ToolMessage] = []
        for tc, result in zip(tool_calls, results):
            if isinstance(result, Exception):
                logger.error("[RUNTIME] tool '%s' failed: %s", tc["name"], result)
                tool_messages.append(self._error_message(tc, str(result)))
            else:
                tool_messages.append(result)

        return tool_messages

    async def _execute_one(
        self,
        tool_call: dict,
        *,
        config: dict[str, Any] | None = None,
    ) -> ToolMessage:
        """Execute a single tool call and return a ToolMessage."""
        name = tool_call["name"]
        args = tool_call.get("args", {})
        call_id = tool_call["id"]

        tool = self._registry.get(name)
        start = time.monotonic()

        try:
            content = await tool.run(**args)
            duration = (time.monotonic() - start) * 1000
            self._record_metrics(name, duration, success=True)
            logger.debug("[RUNTIME] tool '%s' OK (%.0fms)", name, duration)
            return ToolMessage(
                content=content,
                tool_call_id=call_id,
                name=name,
            )
        except Exception as exc:
            duration = (time.monotonic() - start) * 1000
            self._record_metrics(name, duration, success=False, error=str(exc))
            raise  # re-raised to asyncio.gather

    # ── metrics ───────────────────────────────────────────────────────

    def _record_metrics(
        self,
        name: str,
        duration_ms: float,
        *,
        success: bool,
        error: str | None = None,
    ) -> None:
        """Update per-tool metrics."""
        metrics = self._metrics.setdefault(name, ToolMetrics())
        metrics.call_count += 1
        metrics.total_duration_ms += duration_ms
        metrics.last_called_at = time.time()
        if not success:
            metrics.error_count += 1
            metrics.last_error = error

    def monitor(self) -> dict[str, Any]:
        """Return a snapshot of all tool metrics.

        Includes per-tool stats and aggregate totals.
        """
        per_tool: dict[str, dict] = {}
        total_calls = 0
        total_errors = 0

        for name, m in self._metrics.items():
            avg_ms = (m.total_duration_ms / m.call_count) if m.call_count else 0.0
            per_tool[name] = {
                "call_count": m.call_count,
                "avg_duration_ms": round(avg_ms, 1),
                "error_count": m.error_count,
                "last_called_at": m.last_called_at,
            }
            total_calls += m.call_count
            total_errors += m.error_count

        return {
            "tools": per_tool,
            "totals": {
                "call_count": total_calls,
                "error_count": total_errors,
                "registered_tools": len(self._metrics),
            },
            "running": self._started,
        }

    # ── helpers ───────────────────────────────────────────────────────

    def _error_message(self, tool_call: dict, error: str) -> ToolMessage:
        """Build a ToolMessage for a failed tool call."""
        return ToolMessage(
            content=f"工具执行失败: {error}",
            tool_call_id=tool_call["id"],
        )
