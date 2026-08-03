"""Code Agent graph - 5-node ReAct, only binds run_code."""

from __future__ import annotations

import logging
import time
from typing import Any

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import END, StateGraph

from app.agent.lifecycle.circuit import CircuitBreaker
from app.agent.code.handlers import (
    FALLBACK_RESULT,
    UNAVAILABLE_RESULT,
    ErrorCategory,
    as_error_node,
    backoff_delay,
    build_fallback,
    classify_error,
)
from app.agent.code.prompts import SYSTEM_PROMPT
from app.agent.code.state import CodeAgentState
from app.harness.runtime import AgentRuntime
from app.repository import code_execution_repository

logger = logging.getLogger(__name__)


def _has_tool_calls(msg: BaseMessage) -> bool:
    return bool(getattr(msg, "tool_calls", None))


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------


async def inject_prompt(state: CodeAgentState) -> dict[str, Any]:
    """1/5. Build system prompt + user message from query."""
    system = SystemMessage(content=SYSTEM_PROMPT.format(query=state.query))
    user = HumanMessage(content=state.query)
    logger.info("[CODE_AGENT] inject_prompt query=%s", state.query[:80])
    # loguru mirror so code-agent invocation is visible in logs/app.log.
    from loguru import logger as _log
    _log.info(
        "[CODE_AGENT] inject_prompt query='{}' uid={} session={} msg={}",
        state.query[:80], state.uid, state.chat_session_id, state.assistant_msg_id,
    )
    return {"messages": [system, user]}


async def call_agent(state: CodeAgentState, llm_with_tools: Any) -> dict[str, Any]:
    """2/5. LLM decides: call run_code, or respond."""
    if not state.messages:
        return {"result": FALLBACK_RESULT}
    config = {
        "run_name": f"code_agent_llm_step_{state.retry_count}",
        "tags": ["code_agent", "llm"],
    }
    response = await llm_with_tools.ainvoke(state.messages, config=config)
    if not _has_tool_calls(response):
        return {"messages": [response], "result": response.content.strip()}
    return {"messages": [response]}


async def runtime_dispatch(state: CodeAgentState, runtime: AgentRuntime) -> dict[str, Any]:
    """3/5. Hand tool_calls to AgentRuntime; inject _uid."""
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

    start = time.monotonic()
    tool_messages = await runtime.execute(
        pending,
        config={
            "run_name": "code_agent_tool_dispatch",
            "tags": ["code_agent", "tools"],
            "metadata": {"tool_names": [tc["name"] for tc in pending]},
        },
    )
    latency_ms = int((time.monotonic() - start) * 1000)

    # Record sub-steps so the parent chat agent's SSE can show what
    # the code agent did internally (run_code, etc.). Each run_code call is
    # also persisted to MongoDB (code_executions) for post-hoc review from
    # the admin console and the chat message detail view.
    new_sub_steps = list(state.sub_steps)
    for tc, tm in zip(pending, tool_messages):
        action = tc["name"]
        extras = getattr(tm, "additional_kwargs", None) or {}
        content = str(getattr(tm, "content", ""))
        sub_step = {
            "action": action,
            "query": str(tc.get("args", {}).get("code", ""))[:200],
            "content_preview": content[:200],
        }
        if action == "run_code":
            exec_id = await _persist_run_code(
                state=state,
                tc=tc,
                content=content,
                extras=extras,
                latency_ms=latency_ms,
            )
            if exec_id:
                sub_step["exec_id"] = exec_id
            artifacts = extras.get("artifacts") or []
            if artifacts:
                sub_step["artifacts"] = artifacts
        new_sub_steps.append(sub_step)
    return {"messages": tool_messages, "sub_steps": new_sub_steps}


async def _persist_run_code(
    *,
    state: CodeAgentState,
    tc: dict,
    content: str,
    extras: dict,
    latency_ms: int,
) -> str | None:
    """Persist one run_code execution record. Never raises.

    Returns the exec_id (or None on failure / when Mongo is disabled - note
    ``insert`` still returns an id when disabled, so None strictly means the
    call threw). Failures only log a warning so the agent's main flow is
    unaffected - persistence is best-effort, not a hard dependency.
    """
    args = tc.get("args", {})
    exit_code = extras.get("exit_code", 0)
    timeout = bool(extras.get("timeout", False))
    # On failure the runtime wraps the error into ToolMessage.content; record
    # it as the error field when exit_code indicates failure.
    error = content if exit_code != 0 else None
    try:
        return await code_execution_repository.insert(
            uid=state.uid,
            chat_session_id=state.chat_session_id,
            assistant_msg_id=state.assistant_msg_id,
            delegate_query=state.query,
            code=str(args.get("code", "")),
            language=str(args.get("language", "python")),
            stdout=content,
            exit_code=int(exit_code),
            latency_ms=latency_ms,
            error=error,
            timeout=timeout,
            artifacts=extras.get("artifacts"),
        )
    except Exception as exc:
        logger.warning("[CODE_AGENT] persist run_code failed: %s", exc)
        return None


async def format_result(state: CodeAgentState) -> dict[str, Any]:
    """5/5. Result already set by call_agent; nothing to do."""
    return {}


async def error_node(state: CodeAgentState) -> dict[str, Any]:
    """4/5. Classify error, retry with backoff, or fallback."""
    category = classify_error(state.error)
    logger.error(
        "[CODE_AGENT] error_node node=%s error=%s category=%s retry=%s/%s",
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


def route_after_inject(state: CodeAgentState) -> str:
    if state.error:
        return "error_node"
    # inject_prompt may short-circuit a result (e.g. run_code not registered)
    # without calling the LLM - skip straight to format_result so the LLM
    # never gets a chance to fabricate an "executed successfully" reply.
    if state.result:
        return "format_result"
    return "agent"


def route_after_agent(state: CodeAgentState) -> str:
    if state.error:
        return "error_node"
    if state.messages and _has_tool_calls(state.messages[-1]):
        return "runtime_dispatch"
    return "format_result"


def route_after_dispatch(state: CodeAgentState) -> str:
    return "error_node" if state.error else "agent"


def route_after_error(state: CodeAgentState) -> str:
    if not state.error and state.result:
        return "format_result"
    if not state.error and state.failed_node:
        return state.failed_node
    return "format_result"


# ---------------------------------------------------------------------------
# Graph builder
# ---------------------------------------------------------------------------


def build_code_agent(
    runtime: AgentRuntime,
    llm: Any,
    *,
    circuit_breaker: CircuitBreaker | None = None,
) -> object:
    """Build a 5-node code agent graph - only binds the run_code tool."""
    tool_defs = runtime.list_tool_defs(names=["run_code"])
    has_run_code = bool(tool_defs)
    if not has_run_code:
        from loguru import logger as _log
        _log.warning(
            "[CODE_AGENT] run_code tool not registered (daytona-sdk missing or "
            "misconfigured) - code agent will return 'service unavailable' "
            "instead of letting the LLM fabricate execution results"
        )
    llm_with_tools = llm.bind_tools(tool_defs) if has_run_code else llm

    _inject_err = as_error_node("inject_prompt")(inject_prompt)
    _agent_err = as_error_node("agent")(call_agent)
    _dispatch_err = as_error_node("runtime_dispatch")(runtime_dispatch)
    _format_err = as_error_node("format_result")(format_result)

    async def _inject(s):
        if circuit_breaker and circuit_breaker.is_tripped:
            return {"result": FALLBACK_RESULT, "error": "circuit breaker open"}
        if not has_run_code:
            # run_code not registered - short-circuit to a failure result
            # WITHOUT calling the LLM, so it cannot fabricate "executed ok".
            return {"result": UNAVAILABLE_RESULT}
        return await _inject_err(s)

    async def _agent(s):
        return await _agent_err(s, llm_with_tools=llm_with_tools)

    async def _dispatch(s):
        return await _dispatch_err(s, runtime=runtime)

    async def _error(s):
        return await error_node(s)

    async def _format(s):
        return await _format_err(s)

    graph = StateGraph(CodeAgentState)
    graph.add_node("inject_prompt", _inject)
    graph.add_node("agent", _agent)
    graph.add_node("runtime_dispatch", _dispatch)
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
