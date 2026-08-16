"""Summary Agent graph - single-LLM-call summarization of a chat session.

No tools are bound: the inject node fetches the full conversation history
from MongoDB itself (via ``ContextRetriever``), so the LLM produces the
summary in one pass. This keeps the agent deterministic (no tool-call
round-trip) while staying self-contained and reusable from any caller.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from langgraph.graph import END, StateGraph

from app.agent.lifecycle.circuit import CircuitBreaker
from app.agent.summary.handlers import (
    FALLBACK_RESULT,
    ErrorCategory,
    as_error_node,
    backoff_delay,
    build_fallback,
    classify_error,
)
from app.agent.summary.prompts import EMPTY_RESULT, SYSTEM_PROMPT
from app.agent.summary.state import SummaryAgentState
from app.context.models import ConversationMessage
from app.context.retriever import ContextRetriever

logger = logging.getLogger(__name__)

# Same cap as the get_full_history tool — a session larger than this is
# summarized over its most recent 500 messages.
MAX_HISTORY_MESSAGES = 500


def _has_tool_calls(msg: BaseMessage) -> bool:
    return bool(getattr(msg, "tool_calls", None))


def _format_history(messages: list[ConversationMessage]) -> str:
    """Format the conversation as role-labelled blocks, newlines preserved.

    Unlike the compression-oriented formatters, details are kept verbatim —
    a user-facing summary must not flatten multi-line answers.
    """
    lines: list[str] = []
    for m in messages:
        role = "用户" if m.role == "user" else "助手"
        lines.append(f"【{role}】\n{m.content.strip()}")
    return "\n\n".join(lines)


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------


async def inject_prompt(state: SummaryAgentState, retriever: ContextRetriever) -> dict[str, Any]:
    """1/4. Fetch full history and build system + user messages."""
    history = await retriever.get_recent_messages(
        state.chat_session_id, MAX_HISTORY_MESSAGES
    )
    if not history:
        logger.info(
            "[SUMMARY_AGENT] no history, short-circuit session=%s",
            state.chat_session_id[:8],
        )
        return {"result": EMPTY_RESULT}

    system = SystemMessage(content=SYSTEM_PROMPT)
    user = HumanMessage(
        content=(
            f"{state.query}\n\n"
            f"<conversation>\n{_format_history(history)}\n</conversation>"
        )
    )
    logger.info(
        "[SUMMARY_AGENT] inject_prompt session=%s messages=%d",
        state.chat_session_id[:8],
        len(history),
    )
    return {
        "messages": [system, user],
        "message_count": len(history),
        "first_message_at": datetime.fromtimestamp(history[0].timestamp, tz=timezone.utc),
        "last_message_at": datetime.fromtimestamp(history[-1].timestamp, tz=timezone.utc),
    }


async def call_agent(state: SummaryAgentState, llm: Any) -> dict[str, Any]:
    """2/4. Single LLM call over the formatted history (no tools bound)."""
    if not state.messages:
        return {"result": FALLBACK_RESULT}
    config = {
        "run_name": f"summary_agent_llm_step_{state.retry_count}",
        "tags": ["summary_agent", "llm"],
    }
    response = await llm.ainvoke(state.messages, config=config)
    if _has_tool_calls(response):
        # Defensive: no tools are bound, so this should never happen.
        return {"messages": [response]}
    return {"messages": [response], "result": (response.content or "").strip()}


async def format_result(state: SummaryAgentState) -> dict[str, Any]:
    """4/4. Result already set by call_agent; nothing to do."""
    return {}


async def error_node(state: SummaryAgentState) -> dict[str, Any]:
    """3/4. Classify error, retry with backoff, or fallback."""
    category = classify_error(state.error)
    logger.error(
        "[SUMMARY_AGENT] error_node node=%s error=%s category=%s retry=%s/%s",
        state.failed_node,
        state.error,
        category.value,
        state.retry_count,
        state.max_retries,
    )
    if category is ErrorCategory.FATAL:
        return build_fallback(state)
    if category is ErrorCategory.RETRYABLE and state.retry_count < state.max_retries:
        await backoff_delay(state.retry_count)
        return {"error": "", "retry_count": state.retry_count + 1}
    return build_fallback(state)


# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------


def route_after_inject(state: SummaryAgentState) -> str:
    if state.error:
        return "error_node"
    if state.result:  # empty-history short-circuit
        return "format_result"
    return "agent"


def route_after_agent(state: SummaryAgentState) -> str:
    if state.error:
        return "error_node"
    return "format_result"


def route_after_error(state: SummaryAgentState) -> str:
    if not state.error and state.result:
        return "format_result"
    if not state.error and state.failed_node:
        return state.failed_node
    return "format_result"


# ---------------------------------------------------------------------------
# Graph builder
# ---------------------------------------------------------------------------


def build_summary_agent(
    llm: Any,
    *,
    retriever: ContextRetriever | None = None,
    circuit_breaker: CircuitBreaker | None = None,
) -> object:
    """Build a 4-node summary agent graph — no tools, single LLM call."""
    _retriever = retriever or ContextRetriever()

    _inject_err = as_error_node("inject_prompt")(inject_prompt)
    _agent_err = as_error_node("agent")(call_agent)
    _format_err = as_error_node("format_result")(format_result)

    async def _inject(s):
        if circuit_breaker and circuit_breaker.is_tripped:
            return {"result": FALLBACK_RESULT, "error": "circuit breaker open"}
        return await _inject_err(s, retriever=_retriever)

    async def _agent(s):
        return await _agent_err(s, llm=llm)

    async def _error(s):
        return await error_node(s)

    async def _format(s):
        return await _format_err(s)

    graph = StateGraph(SummaryAgentState)
    graph.add_node("inject_prompt", _inject)
    graph.add_node("agent", _agent)
    graph.add_node("error_node", _error)
    graph.add_node("format_result", _format)

    graph.set_entry_point("inject_prompt")
    graph.add_conditional_edges(
        "inject_prompt",
        route_after_inject,
        {"error_node": "error_node", "agent": "agent", "format_result": "format_result"},
    )
    graph.add_conditional_edges(
        "agent",
        route_after_agent,
        {"error_node": "error_node", "format_result": "format_result"},
    )
    graph.add_conditional_edges(
        "error_node",
        route_after_error,
        {
            "inject_prompt": "inject_prompt",
            "agent": "agent",
            "format_result": "format_result",
        },
    )
    graph.add_edge("format_result", END)

    return graph.compile()
