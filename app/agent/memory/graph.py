"""Memory Agent — retrieval specialist for other agents.

5-node architecture (tools executed by AgentRuntime, not the graph)::

    START → inject_window → agent ──(tool_calls)──→ runtime_dispatch → agent (loop)
                              │
                              └──(respond)──→ update_window → END
                                                ↑
    error_node ◄──(error on any node)───────────┘
        ├── retry (backoff) → failed_node
        └── fallback → update_window

    Node                Role
    ───────────────────────────────────────────────────────────
    inject_window       Inject 30-item search window + query
    agent               LLM with tools (declared via runtime.list_tool_defs())
    runtime_dispatch    Delegate tool_calls to AgentRuntime for execution
    error_node          Classify error, retry with backoff, or fallback
    update_window       Record query + result into 30-item window
"""

from __future__ import annotations

import logging
from typing import Any

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import END, StateGraph

from app.agent.lifecycle.circuit import CircuitBreaker
from app.agent.memory.handlers import (
    FALLBACK_RESULT,
    ErrorCategory,
    as_error_node,
    backoff_delay,
    build_fallback,
    classify_error,
)
from app.agent.memory.prompts import SYSTEM_PROMPT
from app.agent.memory.state import (
    AgentState,
    format_search_window,
    make_search_entry,
    push_search_window,
)
from app.harness.runtime import AgentRuntime

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _has_tool_calls(msg: BaseMessage) -> bool:
    return bool(getattr(msg, "tool_calls", None))


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------


async def inject_window(state: AgentState) -> dict[str, Any]:
    """1/5. Build system prompt from 30-item search window + incoming query."""
    search_window_text = format_search_window(state.search_window)

    system = SystemMessage(
        content=SYSTEM_PROMPT.format(
            query=state.query,
            target_agent=state.target_agent or "unknown",
            search_window_text=search_window_text,
        )
    )
    user = HumanMessage(content=state.query)

    logger.info(
        "[MEM_AGENT] inject_window query={} window_size={} target={}",
        state.query[:80],
        len(state.search_window),
        state.target_agent,
    )

    return {"messages": [system, user]}


async def call_agent(state: AgentState, llm_with_tools: Any) -> dict[str, Any]:
    """2/5. LLM decides: return cached window result, or call tools, or respond."""
    if not state.messages:
        return {"result": FALLBACK_RESULT}

    config = {
        "run_name": f"memory_agent_llm_step_{state.retry_count}",
        "tags": ["memory_agent", "llm"],
        "metadata": {
            "retry_count": state.retry_count,
            "target_agent": state.target_agent or "unknown",
        },
    }
    response = await llm_with_tools.ainvoke(state.messages, config=config)
    if not _has_tool_calls(response):
        return {"messages": [response], "result": response.content.strip()}
    return {"messages": [response]}


async def runtime_dispatch(state: AgentState, runtime: AgentRuntime) -> dict[str, Any]:
    """3/5. Hand tool_calls to AgentRuntime for execution.

    The LLM emitted ``tool_calls`` in its last message.  We extract them,
    give them to the runtime (the real executor), and inject the resulting
    ``ToolMessage`` s back into the state so the LLM can continue.
    """
    last_msg = state.messages[-1]
    tool_calls = getattr(last_msg, "tool_calls", None)
    if not tool_calls:
        return {}

    # Gather existing tool_call_ids that already have results
    # (prevents re-execution on retry with partial results)
    existing_ids = {
        m.tool_call_id
        for m in state.messages
        if isinstance(m, ToolMessage) and m.tool_call_id is not None
    }

    pending = [tc for tc in tool_calls if tc["id"] not in existing_ids]
    if not pending:
        return {}

    tool_messages = await runtime.execute(
        pending,
        config={
            "run_name": "memory_agent_tool_dispatch",
            "tags": ["memory_agent", "tools"],
            "metadata": {
                "tool_names": [tc["name"] for tc in pending],
                "target_agent": state.target_agent or "unknown",
            },
        },
    )
    return {"messages": tool_messages}


async def update_window(state: AgentState) -> dict[str, Any]:
    """5/5. Record the query + result into the 30-item sliding window."""
    tools_used: list[str] = []
    for msg in state.messages:
        if isinstance(msg, BaseMessage) and hasattr(msg, "tool_calls"):
            for tc in getattr(msg, "tool_calls", []):
                if isinstance(tc, dict):
                    tools_used.append(tc.get("name", "unknown"))

    entry = make_search_entry(
        query=state.query,
        result=state.result or state.error or "",
        tools_used=tools_used,
    )
    updated = push_search_window(state.search_window, entry)

    logger.debug(
        "[MEM_AGENT] update_window query={} window_size={}",
        state.query[:80],
        len(updated),
    )
    return {"search_window": updated}


async def error_node(state: AgentState) -> dict[str, Any]:
    """4/5. Classify error and decide: retry or fallback."""
    category = classify_error(state.error)

    logger.error(
        "[MEM_AGENT] error_node node={} error={} category={} retry={}/{}",
        state.failed_node, state.error, category.value,
        state.retry_count, state.max_retries,
    )

    if category is ErrorCategory.FATAL:
        logger.critical("[MEM_AGENT] fatal error in {}: {}", state.failed_node, state.error)
        return build_fallback(state)

    if category is ErrorCategory.RETRYABLE and state.retry_count < state.max_retries:
        await backoff_delay(state.retry_count)
        return {"error": "", "retry_count": state.retry_count + 1}

    return build_fallback(state)


# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------


def route_after_inject(state: AgentState) -> str:
    return "error_node" if state.error else "agent"


def route_after_agent(state: AgentState) -> str:
    """After agent: error → error_node, tool_calls → runtime_dispatch, respond → update_window."""
    if state.error:
        return "error_node"
    if state.messages and _has_tool_calls(state.messages[-1]):
        return "runtime_dispatch"
    return "update_window"


def route_after_dispatch(state: AgentState) -> str:
    """After runtime_dispatch: error → error_node, ok → agent."""
    return "error_node" if state.error else "agent"


def route_after_error(state: AgentState) -> str:
    """After error_node: fallback → update_window, retry → failed_node."""
    if not state.error and state.result:
        return "update_window"
    # failed_node defaults to "" (falsy) — Python's empty-string check
    # protects against routing to a non-existent node.
    if not state.error and state.failed_node:
        return state.failed_node
    return "update_window"


# ---------------------------------------------------------------------------
# Graph builder
# ---------------------------------------------------------------------------


def build_memory_agent(
    runtime: AgentRuntime,
    llm: Any,
    *,
    circuit_breaker: CircuitBreaker | None = None,
) -> object:
    """Build a 5-node memory agent graph — tools executed by *runtime*.

    Parameters
    ----------
    runtime:
        ``AgentRuntime`` — provides tool definitions for ``bind_tools()``
        and executes ``tool_calls`` when the LLM requests them.
    llm:
        LangChain ``BaseChatModel`` that supports ``bind_tools()``.
    circuit_breaker:
        Optional ``CircuitBreaker`` for global failure tracking.

    Returns
    -------
    Compiled ``StateGraph``.

    Usage via lifecycle manager::

        manager = AgentLifecycleManager()
        manager.register(
            "memory", build_memory_agent,
            runtime=runtime, llm=llm,
        )
    """
    tool_defs = runtime.list_tool_defs()
    llm_with_tools = llm.bind_tools(tool_defs)

    # Wrap nodes with error handling
    _inject_err = as_error_node("inject_window")(inject_window)
    _agent_err = as_error_node("agent")(call_agent)
    _dispatch_err = as_error_node("runtime_dispatch")(runtime_dispatch)
    _update_err = as_error_node("update_window")(update_window)

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

    async def _update(s):
        return await _update_err(s)

    graph = StateGraph(AgentState)

    graph.add_node("inject_window", _inject)
    graph.add_node("agent", _agent)
    graph.add_node("runtime_dispatch", _dispatch)
    graph.add_node("error_node", _error)
    graph.add_node("update_window", _update)

    # ── edges ────────────────────────────────────────────────────────
    graph.set_entry_point("inject_window")

    graph.add_conditional_edges(
        "inject_window", route_after_inject,
        {"error_node": "error_node", "agent": "agent"},
    )
    graph.add_conditional_edges(
        "agent", route_after_agent,
        {
            "error_node": "error_node",
            "runtime_dispatch": "runtime_dispatch",
            "update_window": "update_window",
        },
    )
    graph.add_conditional_edges(
        "runtime_dispatch", route_after_dispatch,
        {"error_node": "error_node", "agent": "agent"},
    )
    graph.add_conditional_edges(
        "error_node", route_after_error,
        {
            "inject_window": "inject_window",
            "agent": "agent",
            "runtime_dispatch": "runtime_dispatch",
            "update_window": "update_window",
        },
    )

    graph.add_edge("update_window", END)

    return graph.compile()


def create_memory_agent(
    runtime: AgentRuntime,
    llm: Any,
    *,
    circuit_breaker: CircuitBreaker | None = None,
) -> object:
    """Shorthand for ``build_memory_agent``."""
    return build_memory_agent(runtime, llm, circuit_breaker=circuit_breaker)
