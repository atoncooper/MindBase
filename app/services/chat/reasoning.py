"""Reasoning-step extraction for the agentic endpoint.

The Chat Agent's ReAct loop produces a sequence of (AIMessage with
``tool_calls``, matching ToolMessage(s)) pairs.  The legacy
``/chat/ask/agentic`` response shape exposed those as ``reasoning_steps``
with fields ``step / action / query / reasoning / sources / content_preview``.

This module reconstructs that view from the agent's final ``messages``
list so we can keep the public response schema stable while the
underlying engine moved from ``ChatHarness`` to the LangGraph agent.
"""

from __future__ import annotations

import json
from typing import Any, Iterable

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage

_PREVIEW_LIMIT = 200


def _content_preview(value: Any) -> str:
    if value is None:
        return ""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    if len(text) > _PREVIEW_LIMIT:
        return text[:_PREVIEW_LIMIT] + "..."
    return text


def _index_tool_messages(messages: Iterable[BaseMessage]) -> dict[str, ToolMessage]:
    by_id: dict[str, ToolMessage] = {}
    for msg in messages:
        if isinstance(msg, ToolMessage) and msg.tool_call_id:
            by_id[msg.tool_call_id] = msg
    return by_id


def _safe_args(call: dict[str, Any]) -> dict[str, Any]:
    args = call.get("args") or {}
    return {k: v for k, v in args.items() if not str(k).startswith("_")}


def _query_from_args(args: dict[str, Any]) -> str:
    for key in ("query", "question", "q", "text"):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _sources_from_tool_message(msg: ToolMessage) -> list[dict[str, Any]]:
    """Pull a ``sources`` list out of a tool message payload, if present."""
    payload = msg.content
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (TypeError, ValueError):
            return []
    if isinstance(payload, dict):
        sources = payload.get("sources") or payload.get("results") or []
        if isinstance(sources, list):
            return [s for s in sources if isinstance(s, dict)]
    return []


def extract_reasoning_steps(messages: list[BaseMessage]) -> list[dict[str, Any]]:
    """Pair each ``AIMessage(tool_calls=...)`` with its ToolMessages.

    Returns a list of dicts shaped like the legacy ``ReasoningStep`` payload
    so router responses stay backward compatible.
    """
    if not messages:
        return []

    tool_index = _index_tool_messages(messages)
    steps: list[dict[str, Any]] = []
    step_no = 0

    for msg in messages:
        if not isinstance(msg, AIMessage):
            continue
        tool_calls = getattr(msg, "tool_calls", None) or []
        if not tool_calls:
            continue

        for call in tool_calls:
            step_no += 1
            args = _safe_args(call)
            query = _query_from_args(args)
            tool_msg = tool_index.get(call.get("id", ""))
            sources = _sources_from_tool_message(tool_msg) if tool_msg else []
            preview = _content_preview(getattr(tool_msg, "content", "")) if tool_msg else ""

            steps.append(
                {
                    "step": step_no,
                    "action": call.get("name", "tool_call"),
                    "query": query,
                    "reasoning": getattr(msg, "content", "") or "",
                    "sources": sources,
                    "content_preview": preview,
                }
            )

    return steps
