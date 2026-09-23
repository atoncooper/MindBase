"""Board Agent graph — ReAct over the board MCP proxy tools.

Topology mirrors the Note Agent (5 nodes + error router). Board-specific
behaviour lives in ``inject_context``: conversation history (same chat
session) and, when the request is scoped to a board (panel board chat), a
board-context hint pointing the LLM at the board_get tool.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import END, StateGraph

from app.agent.board.handlers import (
    FALLBACK_RESULT,
    ErrorCategory,
    as_error_node,
    backoff_delay,
    build_fallback,
    classify_error,
)
from app.agent.board.prompts import SYSTEM_PROMPT
from app.agent.board.state import BoardAgentState
from app.harness.runtime import AgentRuntime

logger = logging.getLogger(__name__)

BOARD_TOOL_NAMES = [
    "board_list",
    "board_get",
    "board_navigate",
    "board_create",
    "board_update",
    "board_delete",
]

# ── Deterministic loop guards (externalized — never model judgment) ──
# Budget: hard cap on tool calls executed per turn; beyond it every further
# call is refused and the turn is forced to finalize.
MAX_TOOL_CALLS = 8
# A tool+args pair executed this many times gets refused on the next request.
DUPLICATE_LIMIT = 2
_FAILURE_PREFIXES = (
    "工具执行失败",
    "板子服务暂不可用",
    "板子操作失败",
    "板子操作出现意外错误",
)


def _has_tool_calls(msg: BaseMessage) -> bool:
    return bool(getattr(msg, "tool_calls", None))


def _args_brief(args: dict[str, Any] | None) -> str:
    """Compact, uid-free args rendering for the ledger and duplicate keys."""
    clean = {k: v for k, v in (args or {}).items() if k != "_uid"}
    try:
        text = json.dumps(clean, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        text = str(clean)
    return text[:120]


def _call_key(tool: str, args_brief: str) -> tuple[str, str]:
    """Duplicate-call key. ``args_brief`` is the ledger's compact args string."""
    return (tool, args_brief)


def _is_failure(content: str) -> bool:
    return str(content).startswith(_FAILURE_PREFIXES)


def _render_ledger(state: BoardAgentState) -> str:
    """Human/LLM-readable view of the executed-action ledger.

    Injected into every agent LLM run: this is the model's explicit memory
    of what it already did — without it the only record is raw message
    history, which long reasoning models stop consulting.
    """
    if not state.steps:
        return ""
    lines = ["## 已执行操作台账（系统维护）"]
    for i, s in enumerate(state.steps, 1):
        status = "成功" if s.get("ok") else "失败"
        lines.append(f"{i}. {s.get('tool')} {s.get('args')} → {status}：{s.get('brief', '')}")
    remaining = max(MAX_TOOL_CALLS - state.tool_call_count, 0)
    lines.append(
        f"剩余工具预算 {remaining} 次；同一工具+同参数的第 {DUPLICATE_LIMIT + 1} 次调用会被系统直接拒绝。"
        "所需信息已在上述结果中时，立即停止调用工具并输出最终回答。"
    )
    return "\n".join(lines)


def _stub_superseded(messages: list) -> list:
    """Stub exact-duplicate tool payloads out of the LLM input.

    Key = tool name + content prefix; only the LAST occurrence stays full, so
    stubbing is lossless by construction (the dropped payload is byte-identical
    to one that remains). Keeps repeated reads from re-inflating context.
    """
    last_pos: dict[tuple, int] = {}
    keys: list[tuple[str, str] | None] = []
    for i, m in enumerate(messages):
        if isinstance(m, ToolMessage):
            key = (m.name or "", str(m.content)[:512])
            keys.append(key)
            last_pos[key] = i
        else:
            keys.append(None)
    out: list = []
    for i, m in enumerate(messages):
        key = keys[i]
        if key is not None and last_pos[key] != i:
            out.append(
                ToolMessage(
                    content="[历史重复结果已省略：同名工具的最后一次返回包含相同内容]",
                    tool_call_id=m.tool_call_id,
                    name=m.name,
                )
            )
        else:
            out.append(m)
    return out


def _build_llm_messages(state: BoardAgentState) -> list:
    """Agent LLM input: system(+ledger) + history with duplicate payloads stubbed."""
    msgs = list(state.messages)
    system, rest = msgs[0], msgs[1:]
    ledger = _render_ledger(state)
    if ledger:
        system = SystemMessage(content=f"{system.content}\n\n{ledger}")
    return [system, *_stub_superseded(rest)]


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------


async def inject_context(state: BoardAgentState, deps: Any) -> dict[str, Any]:
    """1/5. Build system + user message; attach conversation history and the
    board-context hint when the request is scoped to a board."""
    history = ""
    if deps is not None and state.session_id:
        try:
            history = await deps.get_conversation_context(state.session_id, state.uid or None)
        except Exception as exc:
            logger.warning("[BOARD_AGENT] conversation context unavailable: %s", exc)

    board_hint = ""
    if state.board_uuid:
        board_hint = (
            f"\n## 当前板子上下文\n"
            f"本次请求来自板子面板，针对 board_uuid={state.board_uuid}。"
            f"涉及该板子的读取/修改请直接使用这个 uuid（board_get 的 version "
            f"要用作 board_update 的 expected_version）。\n"
        )
        if state.board_anchor_text:
            board_hint += (
                f"用户当前在画布上选中的节点文本：「{state.board_anchor_text}」。"
                f"用户说「选中的节点/这里/该节点」指的就是它；建议节点时"
                f" board-nodes 的 anchor_text 用这段文本逐字填入。\n"
            )

    # {query} is the only substitution; replace() because the prompt body
    # contains literal JSON braces that str.format would misread.
    system = SystemMessage(content=SYSTEM_PROMPT.replace("{query}", state.query))
    if history:
        system = SystemMessage(content=f"{system.content}\n\n## 对话历史\n{history}")
    if board_hint:
        system = SystemMessage(content=f"{system.content}{board_hint}")

    user = HumanMessage(content=state.query)
    logger.info(
        "[BOARD_AGENT] inject_context query=%s board_uuid=%s",
        state.query[:80],
        state.board_uuid or "-",
    )
    return {"messages": [system, user]}


async def call_agent(state: BoardAgentState, llm_with_tools: Any) -> dict[str, Any]:
    """2/5. LLM decides: call a board tool, or respond.

    The LLM sees system(+ledger) + history — the ledger is what gives it
    explicit awareness of its own past actions.
    """
    if not state.messages:
        return {"result": FALLBACK_RESULT}
    config = {
        "run_name": f"board_agent_llm_step_{state.retry_count}",
        "tags": ["board_agent", "llm"],
    }
    response = await llm_with_tools.ainvoke(_build_llm_messages(state), config=config)
    if not _has_tool_calls(response):
        return {"messages": [response], "result": response.content.strip()}
    return {"messages": [response]}


async def runtime_dispatch(state: BoardAgentState, runtime: AgentRuntime) -> dict[str, Any]:
    """3/5. Execute tool_calls; refuse duplicates/budget overruns; keep ledger.

    All loop gates are deterministic code here, NOT model judgment:

    * duplicate rejection — a tool+args pair already executed
      ``DUPLICATE_LIMIT`` times gets a synthesized refusal ToolMessage and
      burns no budget;
    * tool budget — at most ``MAX_TOOL_CALLS`` executions per turn;
    * forced finalize — when EVERY pending call is refused, the turn is
      routed to ``finalize`` (forced no-tools answer) instead of looping.

    Every executed or refused call lands in the ``steps`` ledger, which the
    next agent run re-injects as the "what you already did" view.
    """
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

    # Inject _uid so board tools know the user (LLM never passes this).
    if state.uid:
        pending = [
            {**tc, "args": {**tc.get("args", {}), "_uid": state.uid}}
            for tc in pending
        ]

    executed_counts: dict[tuple[str, str], int] = {}
    for s in state.steps:
        if s.get("ok"):
            key = _call_key(s.get("tool", ""), s.get("args") or "")
            executed_counts[key] = executed_counts.get(key, 0) + 1

    fresh: list[dict] = []
    refused: list[tuple[dict, str]] = []
    for tc in pending:
        args_brief = _args_brief(tc.get("args", {}))
        count = executed_counts.get(_call_key(tc["name"], args_brief), 0)
        if count >= DUPLICATE_LIMIT:
            refused.append(
                (tc, f"同参数的 {tc['name']} 已执行 {count} 次，禁止重复调用")
            )
        elif state.tool_call_count + len(fresh) >= MAX_TOOL_CALLS:
            refused.append((tc, f"本回合工具预算（{MAX_TOOL_CALLS} 次）已用尽"))
        else:
            fresh.append(tc)

    ledger_entries: list[dict] = []
    tool_messages: list[ToolMessage] = []

    if fresh:
        executed_msgs = await runtime.execute(
            fresh,
            config={
                "run_name": "board_agent_tool_dispatch",
                "tags": ["board_agent", "tools"],
                "metadata": {"tool_names": [tc["name"] for tc in fresh]},
            },
        )
        tool_messages.extend(executed_msgs)
        for tc, msg in zip(fresh, executed_msgs):
            ledger_entries.append(
                {
                    "tool": tc["name"],
                    "args": _args_brief(tc.get("args", {})),
                    "ok": not _is_failure(str(msg.content)),
                    "brief": str(msg.content)[:120],
                }
            )

    for tc, reason in refused:
        tool_messages.append(
            ToolMessage(
                content=(
                    f"[系统拒绝] {reason}。请基于执行台账与上文已有结果继续，不要再次调用。"
                ),
                tool_call_id=tc["id"],
                name=tc["name"],
            )
        )
        ledger_entries.append(
            {
                "tool": tc["name"],
                "args": _args_brief(tc.get("args", {})),
                "ok": False,
                "brief": "系统拒绝（重复/超预算）",
            }
        )

    update: dict[str, Any] = {
        "messages": tool_messages,
        "steps": state.steps + ledger_entries,
        "tool_call_count": state.tool_call_count + len(fresh),
    }
    if not fresh and refused:
        # Every pending call was refused — the model is spinning on calls the
        # gates already rejected. Force the deterministic exit now.
        update["force_finalize"] = True
    return update


async def finalize_answer(state: BoardAgentState, llm: Any) -> dict[str, Any]:
    """Forced termination: one no-tools LLM call that must answer NOW.

    Reached when the deterministic gates decide the turn is over (budget
    exhausted / everything refused). The plain LLM (tools unbound) cannot
    emit tool calls, so this node always produces a final answer or fails
    into the normal retry/fallback path.
    """
    instruction = SystemMessage(
        content=(
            "系统已判定本回合必须结束（工具预算耗尽或检测到重复调用）。"
            "立即基于已有信息与执行台账给出最终回答，禁止再调用任何工具。"
        )
    )
    config = {
        "run_name": "board_agent_finalize",
        "tags": ["board_agent", "llm", "finalize"],
    }
    response = await llm.ainvoke([*state.messages, instruction], config=config)
    return {"messages": [response], "result": str(response.content or "").strip()}


async def format_result(state: BoardAgentState) -> dict[str, Any]:
    """5/5. Result already set by call_agent; nothing to do."""
    return {}


async def error_node(state: BoardAgentState) -> dict[str, Any]:
    """4/5. Classify error, retry with backoff, or fallback."""
    category = classify_error(state.error)
    logger.error(
        "[BOARD_AGENT] error_node node=%s error=%s category=%s retry=%s/%s",
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


def route_after_inject(state: BoardAgentState) -> str:
    return "error_node" if state.error else "agent"


def route_after_agent(state: BoardAgentState) -> str:
    if state.error:
        return "error_node"
    if state.messages and _has_tool_calls(state.messages[-1]):
        return "runtime_dispatch"
    return "format_result"


def route_after_dispatch(state: BoardAgentState) -> str:
    if state.error:
        return "error_node"
    if state.force_finalize:
        return "finalize"
    return "agent"


def route_after_error(state: BoardAgentState) -> str:
    if not state.error and state.result:
        return "format_result"
    if not state.error and state.failed_node:
        return state.failed_node
    return "format_result"


# ---------------------------------------------------------------------------
# Graph builder
# ---------------------------------------------------------------------------


def build_board_agent(
    runtime: AgentRuntime,
    llm: Any,
    *,
    deps: Any = None,
    circuit_breaker: Any = None,
) -> object:
    """Build the board agent graph — binds only the board_* MCP proxy tools."""
    tool_defs = runtime.list_tool_defs(names=BOARD_TOOL_NAMES)
    llm_with_tools = llm.bind_tools(tool_defs)

    _inject_err = as_error_node("inject_context")(inject_context)
    _agent_err = as_error_node("agent")(call_agent)
    _dispatch_err = as_error_node("runtime_dispatch")(runtime_dispatch)
    _format_err = as_error_node("format_result")(format_result)
    _finalize_err = as_error_node("finalize")(finalize_answer)

    async def _inject(s):
        if circuit_breaker and circuit_breaker.is_tripped:
            return {"result": FALLBACK_RESULT, "error": "circuit breaker open"}
        return await _inject_err(s, deps=deps)

    async def _agent(s):
        return await _agent_err(s, llm_with_tools=llm_with_tools)

    async def _dispatch(s):
        return await _dispatch_err(s, runtime=runtime)

    async def _error(s):
        return await error_node(s)

    async def _format(s):
        return await _format_err(s)

    async def _finalize(s):
        return await _finalize_err(s, llm=llm)

    graph = StateGraph(BoardAgentState)
    graph.add_node("inject_context", _inject)
    graph.add_node("agent", _agent)
    graph.add_node("runtime_dispatch", _dispatch)
    graph.add_node("error_node", _error)
    graph.add_node("format_result", _format)
    graph.add_node("finalize", _finalize)

    graph.set_entry_point("inject_context")
    graph.add_conditional_edges(
        "inject_context",
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
        {
            "error_node": "error_node",
            "agent": "agent",
            "finalize": "finalize",
        },
    )
    graph.add_conditional_edges(
        "error_node",
        route_after_error,
        {
            "inject_context": "inject_context",
            "agent": "agent",
            "runtime_dispatch": "runtime_dispatch",
            "finalize": "finalize",
            "format_result": "format_result",
        },
    )
    graph.add_edge("finalize", "format_result")
    graph.add_edge("format_result", END)

    return graph.compile()
