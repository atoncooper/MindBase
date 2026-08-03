"""Note Agent graph - 5-node ReAct, only binds save_note."""

from __future__ import annotations

import logging
from typing import Any

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import END, StateGraph

from app.agent.lifecycle.circuit import CircuitBreaker
from app.agent.note.handlers import (
    FALLBACK_RESULT,
    ErrorCategory,
    as_error_node,
    backoff_delay,
    build_fallback,
    classify_error,
)
from app.agent.note.prompts import SYSTEM_PROMPT
from app.agent.note.state import NoteAgentState
from app.harness.runtime import AgentRuntime

logger = logging.getLogger(__name__)


def _has_tool_calls(msg: BaseMessage) -> bool:
    return bool(getattr(msg, "tool_calls", None))


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------


async def inject_prompt(state: NoteAgentState) -> dict[str, Any]:
    """1/5. Build system prompt + user message from query."""
    system = SystemMessage(content=SYSTEM_PROMPT.format(query=state.query))
    user = HumanMessage(content=state.query)
    logger.info("[NOTE_AGENT] inject_prompt query=%s", state.query[:80])
    return {"messages": [system, user]}


async def call_agent(state: NoteAgentState, llm_with_tools: Any) -> dict[str, Any]:
    """2/5. LLM decides: call save_note tool, or respond."""
    if not state.messages:
        return {"result": FALLBACK_RESULT}
    config = {
        "run_name": f"note_agent_llm_step_{state.retry_count}",
        "tags": ["note_agent", "llm"],
    }
    response = await llm_with_tools.ainvoke(state.messages, config=config)
    if not _has_tool_calls(response):
        return {"messages": [response], "result": response.content.strip()}
    return {"messages": [response]}


async def runtime_dispatch(state: NoteAgentState, runtime: AgentRuntime) -> dict[str, Any]:
    """3/5. Hand tool_calls to AgentRuntime; inject _uid for save_note."""
    last_msg = state.messages[-1]
    tool_calls = getattr(last_msg, "tool_calls", None)
    if not tool_calls:
        return {}

    existing_ids = {
        m.tool_call_id
        for m in state.messages
        if isinstance(m, ToolMessage) and m.tool_call_id is not None
    }
    pending = [tc for tc in tool_calls if tc["id"] not in existing_ids]
    if not pending:
        return {}

    # Inject _uid so save_note knows the user (LLM never passes this).
    if state.uid:
        pending = [
            {**tc, "args": {**tc.get("args", {}), "_uid": state.uid}}
            for tc in pending
        ]

    tool_messages = await runtime.execute(
        pending,
        config={
            "run_name": "note_agent_tool_dispatch",
            "tags": ["note_agent", "tools"],
            "metadata": {"tool_names": [tc["name"] for tc in pending]},
        },
    )
    return {"messages": tool_messages}


async def format_result(state: NoteAgentState) -> dict[str, Any]:
    """5/5. Result already set by call_agent; nothing to do."""
    return {}


async def error_node(state: NoteAgentState) -> dict[str, Any]:
    """4/5. Classify error, retry with backoff, or fallback."""
    category = classify_error(state.error)
    logger.error(
        "[NOTE_AGENT] error_node node=%s error=%s category=%s retry=%s/%s",
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


def route_after_inject(state: NoteAgentState) -> str:
    return "error_node" if state.error else "agent"


def route_after_agent(state: NoteAgentState) -> str:
    if state.error:
        return "error_node"
    if state.messages and _has_tool_calls(state.messages[-1]):
        return "runtime_dispatch"
    return "format_result"


def route_after_dispatch(state: NoteAgentState) -> str:
    return "error_node" if state.error else "agent"


def route_after_error(state: NoteAgentState) -> str:
    if not state.error and state.result:
        return "format_result"
    if not state.error and state.failed_node:
        return state.failed_node
    return "format_result"


# ---------------------------------------------------------------------------
# Graph builder
# ---------------------------------------------------------------------------


def build_note_agent(
    runtime: AgentRuntime,
    llm: Any,
    *,
    circuit_breaker: CircuitBreaker | None = None,
) -> object:
    """Build a 5-node note agent graph - only binds the save_note tool."""
    tool_defs = runtime.list_tool_defs(names=["save_note", "list_notes", "get_note", "update_note", "vector_search"])
    llm_with_tools = llm.bind_tools(tool_defs)

    _inject_err = as_error_node("inject_prompt")(inject_prompt)
    _agent_err = as_error_node("agent")(call_agent)
    _dispatch_err = as_error_node("runtime_dispatch")(runtime_dispatch)
    _format_err = as_error_node("format_result")(format_result)

    async def _inject(s):
        if circuit_breaker and circuit_breaker.is_tripped:
            return {"result": FALLBACK_RESULT, "error": "circuit breaker open"}
        return await _inject_err(s)

    async def _agent(s):
        return await _agent_err(s, llm_with_tools=llm_with_tools)

    async def _dispatch(s):
        return await _dispatch_err(s, runtime=runtime)

    async def _error(s):
        return await error_node(s)

    async def _format(s):
        return await _format_err(s)

    graph = StateGraph(NoteAgentState)
    graph.add_node("inject_prompt", _inject)
    graph.add_node("agent", _agent)
    graph.add_node("runtime_dispatch", _dispatch)
    graph.add_node("error_node", _error)
    graph.add_node("format_result", _format)

    graph.set_entry_point("inject_prompt")
    graph.add_conditional_edges(
        "inject_prompt",
        route_after_inject,
        {"error_node": "error_node", "agent": "agent"},
    )
    graph.add_conditional_edges(
        "agent",
        route_after_agent,
        {
            "error_node": "error_node",
            "runtime_dispatch": "runtime_dispatch",
            "format_result": "format_result",
        },
    )
    graph.add_conditional_edges(
        "runtime_dispatch",
        route_after_dispatch,
        {"error_node": "error_node", "agent": "agent"},
    )
    graph.add_conditional_edges(
        "error_node",
        route_after_error,
        {
            "inject_prompt": "inject_prompt",
            "agent": "agent",
            "runtime_dispatch": "runtime_dispatch",
            "format_result": "format_result",
        },
    )
    graph.add_edge("format_result", END)

    return graph.compile()
