"""Search Agent graph - 5-node ReAct, binds search_docs."""

from __future__ import annotations

import logging
from typing import Any

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import END, StateGraph

from app.agent.lifecycle.circuit import CircuitBreaker
from app.agent.search.handlers import (
    FALLBACK_RESULT,
    ErrorCategory,
    as_error_node,
    backoff_delay,
    build_fallback,
    classify_error,
)
from app.agent.search.prompts import SYSTEM_PROMPT
from app.agent.search.state import SearchAgentState
from app.harness.runtime import AgentRuntime

logger = logging.getLogger(__name__)


def _has_tool_calls(msg: BaseMessage) -> bool:
    return bool(getattr(msg, "tool_calls", None))


async def inject_prompt(state: SearchAgentState) -> dict[str, Any]:
    system = SystemMessage(content=SYSTEM_PROMPT.format(query=state.query))
    user = HumanMessage(content=state.query)
    logger.info("[SEARCH_AGENT] inject_prompt query=%s", state.query[:80])
    return {"messages": [system, user]}


async def call_agent(state: SearchAgentState, llm_with_tools: Any) -> dict[str, Any]:
    if not state.messages:
        return {"result": FALLBACK_RESULT}
    config = {
        "run_name": f"search_agent_llm_step_{state.retry_count}",
        "tags": ["search_agent", "llm"],
    }
    response = await llm_with_tools.ainvoke(state.messages, config=config)
    if not _has_tool_calls(response):
        return {"messages": [response], "result": response.content.strip()}
    return {"messages": [response]}


async def runtime_dispatch(state: SearchAgentState, runtime: AgentRuntime) -> dict[str, Any]:
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

    if state.uid:
        pending = [
            {**tc, "args": {**tc.get("args", {}), "_uid": state.uid}}
            for tc in pending
        ]

    tool_messages = await runtime.execute(
        pending,
        config={
            "run_name": "search_agent_tool_dispatch",
            "tags": ["search_agent", "tools"],
            "metadata": {"tool_names": [tc["name"] for tc in pending]},
        },
    )

    # Record sub-steps for SSE reporting
    new_sub_steps = list(state.sub_steps)
    for tc, tm in zip(pending, tool_messages):
        new_sub_steps.append({
            "action": tc["name"],
            "query": str(tc.get("args", {}).get("query", ""))[:200],
            "content_preview": str(getattr(tm, "content", ""))[:200],
        })
    return {"messages": tool_messages, "sub_steps": new_sub_steps}


async def format_result(state: SearchAgentState) -> dict[str, Any]:
    return {}


async def error_node(state: SearchAgentState) -> dict[str, Any]:
    category = classify_error(state.error)
    logger.error(
        "[SEARCH_AGENT] error_node node=%s error=%s category=%s retry=%s/%s",
        state.failed_node, state.error, category.value, state.retry_count, state.max_retries,
    )
    if category is ErrorCategory.FATAL:
        return build_fallback(state)
    if category is ErrorCategory.RETRYABLE and state.retry_count < state.max_retries:
        await backoff_delay(state.retry_count)
        return {"error": "", "retry_count": state.retry_count + 1}
    return build_fallback(state)


def route_after_inject(state: SearchAgentState) -> str:
    return "error_node" if state.error else "agent"


def route_after_agent(state: SearchAgentState) -> str:
    if state.error:
        return "error_node"
    if state.messages and _has_tool_calls(state.messages[-1]):
        return "runtime_dispatch"
    return "format_result"


def route_after_dispatch(state: SearchAgentState) -> str:
    return "error_node" if state.error else "agent"


def route_after_error(state: SearchAgentState) -> str:
    if not state.error and state.result:
        return "format_result"
    if not state.error and state.failed_node:
        return state.failed_node
    return "format_result"


def build_search_agent(
    runtime: AgentRuntime,
    llm: Any,
    *,
    circuit_breaker: CircuitBreaker | None = None,
) -> object:
    """Build a 5-node search agent graph - binds search_docs."""
    tool_defs = runtime.list_tool_defs(names=["search_docs", "web_crawl"])
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

    graph = StateGraph(SearchAgentState)
    graph.add_node("inject_prompt", _inject)
    graph.add_node("agent", _agent)
    graph.add_node("runtime_dispatch", _dispatch)
    graph.add_node("error_node", _error)
    graph.add_node("format_result", _format)

    graph.set_entry_point("inject_prompt")
    graph.add_conditional_edges("inject_prompt", route_after_inject, {"error_node": "error_node", "agent": "agent"})
    graph.add_conditional_edges("agent", route_after_agent, {"error_node": "error_node", "runtime_dispatch": "runtime_dispatch", "format_result": "format_result"})
    graph.add_conditional_edges("runtime_dispatch", route_after_dispatch, {"error_node": "error_node", "agent": "agent"})
    graph.add_conditional_edges("error_node", route_after_error, {"inject_prompt": "inject_prompt", "agent": "agent", "runtime_dispatch": "runtime_dispatch", "format_result": "format_result"})
    graph.add_edge("format_result", END)

    return graph.compile()
