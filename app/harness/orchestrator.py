"""AgentOrchestrator — LLM-based meta-router for agent selection.

Uses a single fast LLM call (temperature=0) to classify a user query
against registered agent descriptions, then returns the agent name.
Falls back to a default agent on any failure.

Usage::

    from app.harness.orchestrator import AgentOrchestrator

    orch = AgentOrchestrator(llm=my_llm, default_agent="chat")
    orch.register("chat", "Knowledge-base Q&A agent for B站 videos and cloud docs.")
    orch.register("memory", "Conversation history retrieval agent.")

    agent_name = await orch.route("总结收藏夹内容")
    # → "chat"
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

logger = logging.getLogger(__name__)

_ROUTING_SYSTEM_TEMPLATE = (
    "你是一个查询路由专家。根据用户问题和可用 Agent 描述，选择最合适的 Agent。\n"
    "\n"
    "可用 Agent:\n"
    "{agent_list}\n"
    "\n"
    "只输出 Agent 名称（{agent_names}），不要解释，不要加标点。"
)


@dataclass(frozen=True)
class AgentDescriptor:
    """Metadata for a registered agent — used by the orchestrator for routing."""

    name: str
    description: str
    default: bool = False


class AgentOrchestrator:
    """LLM-based agent router — chooses which registered agent handles a query.

    Composed into ``AgentHarness``; not used standalone.
    """

    def __init__(
        self,
        llm: Any,
        default_agent: str = "chat",
        routing_timeout: float = 3.0,
    ) -> None:
        self._llm = llm
        self._default_agent = default_agent
        self._routing_timeout = routing_timeout
        self._agents: dict[str, AgentDescriptor] = {}
        self._prompt_cache: str | None = None

    # ── registration ─────────────────────────────────────────────────

    def register(
        self,
        name: str,
        description: str,
        *,
        default: bool = False,
    ) -> None:
        """Register an agent with a human-readable description.

        Args:
            name: Agent type name (must match lifecycle registration).
            description: Natural-language description for the LLM routing prompt.
            default: Set True for the fallback agent when routing fails.
        """
        self._agents[name] = AgentDescriptor(
            name=name,
            description=description,
            default=default,
        )
        if default:
            self._default_agent = name
        self._prompt_cache = None  # invalidate cache
        logger.info("[ORCHESTRATOR] registered agent '%s' (default=%s)", name, default)

    def unregister(self, name: str) -> None:
        """Remove an agent from the routing table."""
        if name in self._agents:
            del self._agents[name]
            self._prompt_cache = None
            logger.info("[ORCHESTRATOR] unregistered agent '%s'", name)

    def list_agents(self) -> list[dict[str, Any]]:
        """Return info about all registered agents."""
        return [
            {"name": d.name, "description": d.description, "default": d.default}
            for d in self._agents.values()
        ]

    # ── routing ──────────────────────────────────────────────────────

    async def route(self, query: str, **context: Any) -> str:
        """Choose the best agent for a query. Returns agent name.

        1. If only one agent registered, return it immediately.
        2. Build routing prompt from cached agent list.
        3. Call LLM with temperature=0 and routing_timeout.
        4. Parse response with regex against registered agent names.
        5. Fallback to default agent on any failure.
        """
        if not self._agents:
            logger.warning("[ORCHESTRATOR] no agents registered, returning empty")
            return self._default_agent

        if len(self._agents) == 1:
            return next(iter(self._agents))

        try:
            prompt = self._build_prompt(query)
            messages = [
                SystemMessage(content=prompt),
                HumanMessage(content=query),
            ]
            resp = await asyncio.wait_for(
                self._llm.ainvoke(messages),
                timeout=self._routing_timeout,
            )
            text = (resp.content or "").strip()
            name = self._parse_agent_name(text)
            if name:
                logger.info("[ORCHESTRATOR] route: query='%s' → '%s'", query[:60], name)
                return name

            logger.warning(
                "[ORCHESTRATOR] couldn't parse route from '%s', defaulting to '%s'",
                text[:50],
                self._default_agent,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "[ORCHESTRATOR] routing timed out (%.1fs), defaulting to '%s'",
                self._routing_timeout,
                self._default_agent,
            )
        except Exception as exc:
            logger.warning("[ORCHESTRATOR] routing failed: %s", exc)

        return self._default_agent

    # ── internal ─────────────────────────────────────────────────────

    def _build_prompt(self, query: str) -> str:
        """Build the routing system prompt from cached agent descriptions."""
        if self._prompt_cache is None:
            agent_lines = "\n".join(
                f"- {d.name}: {d.description}" for d in self._agents.values()
            )
            agent_names = "/".join(self._agents.keys())
            self._prompt_cache = _ROUTING_SYSTEM_TEMPLATE.format(
                agent_list=agent_lines,
                agent_names=agent_names,
            )
        return self._prompt_cache

    def _parse_agent_name(self, text: str) -> str | None:
        """Extract a valid agent name from the LLM response."""
        names = list(self._agents.keys())
        pattern = r"\b(" + "|".join(re.escape(n) for n in names) + r")\b"
        match = re.search(pattern, text)
        return match.group(1) if match else None
