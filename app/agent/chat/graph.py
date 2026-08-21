"""Chat Agent graph — ReAct pattern with tool-calling loop.

Node flow::

    inject_context → agent ──(tool_calls)──→ runtime_dispatch → agent (loop)
                        │
                        └──(respond)──→ format_result → END

    error_node ◄──(error on any node)
        ├── retry → failed_node
        └── fallback → format_result

The LLM is in the loop: it decides which tools to call, whether results
are sufficient, and when to produce the final answer.  This is genuine
ReAct — not a deterministic pipeline.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from langchain_core.messages import BaseMessage
from langgraph.graph import END, StateGraph

from app.agent.chat.error_handling import as_error_node
from app.agent.chat.prompts import build_system_prompt
from app.agent.chat.state import ChatAgentState
from app.agent.lifecycle.circuit import CircuitBreaker
from app.harness.runtime import AgentRuntime

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _has_tool_calls(msg: BaseMessage) -> bool:
    return bool(getattr(msg, "tool_calls", None))


async def _noop_list() -> list:
    """Placeholder coroutine for conditional asyncio.gather branches."""
    return []


async def _noop_str() -> str:
    """Placeholder coroutine for conditional asyncio.gather branches."""
    return ""


async def _load_forced_skills(
    skill_manager: Any, uid: int | None, skill_ids: list[str]
) -> str:
    """Build the forced-skills prompt section from full SKILL.md bodies.

    Unlike the index-only section (skill_manager.index_text), the selected
    skills' full bodies are embedded so the agent follows them this turn
    without calling load_skill. Unknown / uninstalled / failed ids are
    skipped with a warning — one bad id must not break the turn.
    """
    if uid is None:
        return ""
    sections: list[str] = []
    for skill_id in dict.fromkeys(skill_ids):
        if not skill_id:
            continue
        try:
            skill = await skill_manager.load_skill(uid, skill_id)
        except Exception:
            logger.warning(
                "[CHAT_AGENT] forced skill load failed id=%s", skill_id, exc_info=True
            )
            skill = None
        if skill is None or not getattr(skill, "body", ""):
            logger.warning(
                "[CHAT_AGENT] forced skill unavailable, skipped id=%s", skill_id
            )
            continue
        sections.append(f"### 技能：{skill.name}（{skill_id}）\n\n{skill.body}")
    if not sections:
        return ""
    return (
        "## 用户指定技能（本次对话必须遵循）\n\n"
        "以下技能由用户显式选择注入。本次对话必须按这些技能的指令执行，"
        "无需再调用 load_skill 加载它们：\n\n" + "\n\n---\n\n".join(sections)
    )


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------


async def inject_context(
    state: ChatAgentState,
    *,
    deps: Any,
    runtime: AgentRuntime,
    skill_manager: Any = None,
) -> dict[str, Any]:
    """1/4. Resolve data scope + inject system prompt with conversation context.

    ``deps`` must provide:
        - get_media_ids(uid, folder_ids) -> list[int]
        - get_bvids(media_ids) -> list[str]
        - has_cloud_backend() -> bool
        - get_conversation_context(session_id) -> str
    ``runtime`` is used to detect whether context tools are registered.
    """
    uid = state.uid
    folder_ids = state.folder_ids

    # Run independent lookups concurrently: media_ids and conversation_context
    # are mutually independent.  bvids depends on media_ids so it stays serial
    # after the gather.
    #
    # Query rewrite has been REMOVED: the ReAct LLM already optimizes its own
    # retrieval queries (vector_search.description instructs it to disambiguate
    # pronouns / complete context / search from multiple angles), so the extra
    # forced rewrite LLM call only added latency before the first token without
    # improving recall. The LLM decides when and how to rewrite.
    has_ctx = bool(state.session_id and state.uid)
    media_ids, conversation_context = await asyncio.gather(
        deps.get_media_ids(uid, folder_ids) if uid else _noop_list(),
        (
            deps.get_conversation_context(state.session_id, state.uid)
            if has_ctx
            else _noop_str()
        ),
    )
    bvids = await deps.get_bvids(media_ids) if media_ids else []
    has_data = len(bvids) > 0
    cloud_has_data = deps.has_cloud_backend()

    if has_ctx:
        logger.info(
            "[CHAT_AGENT] conversation_context: session_id={} uid={} chars={}",
            state.session_id[:8] if state.session_id else "",
            state.uid,
            len(conversation_context),
        )
        if conversation_context:
            logger.info("  context preview: {}", conversation_context[:200])

    # Always empty: outer rewrite is disabled. Kept as an empty list so
    # runtime_dispatch / vector_search's multi-path (which skips empty
    # rewritten_queries and falls back to a single-query search) is unchanged.
    rewritten_queries: list[str] = []

    # Detect context tools in the registry
    registered = runtime.list_tool_names()
    has_context_tools = (
        "search_chat_history" in registered or "get_recent_context" in registered
    )
    has_delegate = "delegate_to_agent" in registered

    from langchain_core.messages import HumanMessage, SystemMessage

    skills_section = (
        await skill_manager.index_text(state.uid) if skill_manager is not None else ""
    )
    forced_skills_section = (
        await _load_forced_skills(skill_manager, state.uid, state.skill_ids)
        if (skill_manager is not None and state.skill_ids)
        else ""
    )
    if forced_skills_section:
        logger.info(
            "[CHAT_AGENT] forced skills injected count={} ids={}",
            len(state.skill_ids),
            state.skill_ids,
        )
    system = SystemMessage(
        content=build_system_prompt(
            state.query,
            has_data=has_data,
            cloud_has_data=cloud_has_data,
            conversation_context=conversation_context,
            has_context_tools=has_context_tools,
            has_delegate=has_delegate,
            skills_section=skills_section,
            forced_skills_section=forced_skills_section,
        )
    )
    user = HumanMessage(content=state.query)

    return {
        "media_ids": media_ids,
        "bvids": bvids,
        "upload_uuids": state.upload_uuids,  # Passed in from dispatcher state
        "has_data": has_data,
        "cloud_has_data": cloud_has_data,
        "conversation_context": conversation_context,
        "rewritten_queries": rewritten_queries,
        "messages": [system, user],
    }


async def call_agent(state: ChatAgentState, *, llm_with_tools: Any) -> dict[str, Any]:
    """2/4. LLM decides: call a tool, or respond directly.

    When the LLM emits tool_calls, the graph routes to runtime_dispatch.
    When the LLM responds with text, the graph routes to format_result.
    """
    if not state.messages:
        return {"result": "", "error": "no messages in state"}

    config = {
        "run_name": f"chat_agent_llm_step_{state.step_count}",
        "tags": ["chat_agent", "llm"],
        "metadata": {
            "step_count": state.step_count,
            "session_id": state.session_id,
        },
    }
    response = await llm_with_tools.ainvoke(state.messages, config=config)

    if not _has_tool_calls(response):
        return {"messages": [response], "result": response.content.strip()}
    return {"messages": [response]}


# Short-circuit delegate_to_agent after this many failures for the same
# agent_name within a single chat turn. Prevents the LLM from retrying a
# failing sub-agent until max_steps is exhausted.
DELEGATE_TOOL_NAME = "delegate_to_agent"
DELEGATE_FAILURE_THRESHOLD = 2


async def runtime_dispatch(
    state: ChatAgentState, *, runtime: AgentRuntime
) -> dict[str, Any]:
    """3/4. Hand tool_calls to AgentRuntime for execution.

    Extracts pending tool calls (skipping already-executed ones on retry),
    injects ``chat_session_id`` from state for context tools, and delegates
    to the runtime.  Returns ToolMessages back to the graph.
    """
    from langchain_core.messages import ToolMessage

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

    # Inject implicit kwargs from state so tools receive resolved data
    # scope and session context without the LLM needing to pass them.
    implicit_kwargs: dict[str, Any] = {}
    if state.session_id:
        implicit_kwargs["chat_session_id"] = state.session_id
    if state.assistant_msg_id:
        implicit_kwargs["assistant_msg_id"] = state.assistant_msg_id
    if state.bvids:
        implicit_kwargs["_bvids"] = state.bvids
    if state.media_ids:
        implicit_kwargs["_media_ids"] = state.media_ids
    if state.uid:
        implicit_kwargs["_uid"] = state.uid
    if state.workspace_pages:
        implicit_kwargs["_workspace_pages"] = state.workspace_pages
    if state.upload_uuids:
        implicit_kwargs["_upload_uuids"] = state.upload_uuids
    if state.rewritten_queries:
        implicit_kwargs["_rewritten_queries"] = state.rewritten_queries
    if state.delegate_depth:
        implicit_kwargs["delegate_depth"] = state.delegate_depth

    if implicit_kwargs:
        pending = [
            {**tc, "args": {**tc.get("args", {}), **implicit_kwargs}} for tc in pending
        ]

    # Short-circuit delegate_to_agent calls whose target agent has already
    # failed DELEGATE_FAILURE_THRESHOLD times this turn. Prevents the LLM
    # from burning the whole ReAct budget retrying one failing sub-agent.
    short_circuit_msgs: list[ToolMessage] = []
    pending_to_run: list[dict] = []
    for tc in pending:
        if tc["name"] == DELEGATE_TOOL_NAME:
            agent_name = tc.get("args", {}).get("agent_name", "")
            failures = state.delegate_failures.get(agent_name, 0)
            if failures >= DELEGATE_FAILURE_THRESHOLD:
                short_circuit_msgs.append(
                    ToolMessage(
                        content=(
                            f"委托已短路:{agent_name} 在本次对话中已连续失败 {failures} 次,"
                            f"不再委托。请基于已有信息直接回答,或改用其他工具/方式。"
                        ),
                        tool_call_id=tc["id"],
                    )
                )
                continue
        pending_to_run.append(tc)

    tool_messages: list[ToolMessage] = []
    if pending_to_run:
        tool_messages = await runtime.execute(
            pending_to_run,
            config={
                "run_name": "chat_agent_tool_dispatch",
                "tags": ["chat_agent", "tools"],
                "metadata": {
                    "tool_names": [tc["name"] for tc in pending_to_run],
                    "step_count": state.step_count,
                },
            },
        )

    # Detect delegate failures via the structured `failed` flag (set by
    # DelegateToAgentTool, forwarded through additional_kwargs) and bump
    # the per-agent counter so the next delegate to that agent short-circuits.
    new_failures: dict[str, int] = dict(state.delegate_failures)
    for tc, tm in zip(pending_to_run, tool_messages):
        if tc["name"] == DELEGATE_TOOL_NAME:
            extras = getattr(tm, "additional_kwargs", None) or {}
            if extras.get("failed"):
                agent_name = tc.get("args", {}).get("agent_name", "")
                new_failures[agent_name] = new_failures.get(agent_name, 0) + 1

    # Harvest structured sources from ToolMessage.additional_kwargs so the
    # final ``format_result`` step has retrieval provenance to expose. The
    # state field uses ``default_factory=list``, so we explicitly merge
    # against the current value to preserve sources across loop turns.
    new_sources: list[dict] = []
    for tm in tool_messages:
        extras = getattr(tm, "additional_kwargs", None) or {}
        srcs = extras.get("sources")
        if isinstance(srcs, list):
            new_sources.extend(s for s in srcs if isinstance(s, dict))

    update: dict[str, Any] = {
        "messages": [*tool_messages, *short_circuit_msgs],
        "step_count": state.step_count + 1,
    }
    if new_sources:
        update["search_results"] = [*state.search_results, *new_sources]
    if new_failures != state.delegate_failures:
        update["delegate_failures"] = new_failures
    return update


async def format_result(state: ChatAgentState, **_kwargs: Any) -> dict[str, Any]:
    """4/4. Extract deduplicated sources from the state."""
    sources: list[dict] = []
    seen_ids: set[str] = set()

    for src in state.search_results:
        src_id = src.get("bvid") or src.get("upload_uuid", "")
        if src_id and src_id not in seen_ids:
            seen_ids.add(src_id)
            sources.append(src)

    logger.info(
        "[CHAT_AGENT] format_result: search_results={} final_sources={}",
        len(state.search_results),
        len(sources),
    )
    for src in sources:
        logger.info("  - source: {}", src)

    return {"sources": sources}


async def error_node(state: ChatAgentState, **_kwargs: Any) -> dict[str, Any]:
    """Error handler: classify and decide retry or fallback."""
    from app.agent.chat.error_handling import (
        classify_error,
        ErrorCategory,
        FALLBACK_RESULT,
    )

    category = classify_error(state.error)

    logger.error(
        "[CHAT_AGENT] error_node node=%s error=%s category=%s retry=%s/%s",
        state.failed_node,
        state.error,
        category.value,
        state.retry_count,
        state.max_retries,
    )

    if category is ErrorCategory.FATAL:
        return {"result": FALLBACK_RESULT, "error": state.error}

    if category is ErrorCategory.RETRYABLE and state.retry_count < state.max_retries:
        from app.agent.chat.error_handling import backoff_delay

        await backoff_delay(state.retry_count)
        return {"error": "", "retry_count": state.retry_count + 1}

    return {"result": FALLBACK_RESULT, "error": state.error}


# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------


def route_after_inject(state: ChatAgentState) -> str:
    return "error_node" if state.error else "agent"


def route_after_agent(state: ChatAgentState) -> str:
    """After agent: error → error_node, tool_calls → runtime_dispatch, respond → format_result."""
    if state.error:
        return "error_node"
    if state.messages and _has_tool_calls(state.messages[-1]):
        return "runtime_dispatch"
    return "format_result"


def route_after_dispatch(state: ChatAgentState) -> str:
    """After runtime_dispatch: error → error_node, steps exhausted → format_result, ok → agent."""
    if state.error:
        return "error_node"
    if state.step_count >= state.max_steps:
        logger.warning(
            "[CHAT_AGENT] max_steps=%s reached, forcing format_result", state.max_steps
        )
        return "format_result"
    return "agent"


def route_after_error(state: ChatAgentState) -> str:
    """After error_node: fallback → format_result, retry → failed_node."""
    if not state.error and state.result:
        return "format_result"
    if not state.error and state.failed_node:
        return state.failed_node
    return "format_result"


# ---------------------------------------------------------------------------
# Graph builder
# ---------------------------------------------------------------------------


def build_chat_agent(
    *,
    runtime: AgentRuntime,
    llm: Any,
    deps: Any,
    circuit_breaker: CircuitBreaker | None = None,
    skill_manager: Any = None,
) -> object:
    """Build the ReAct Chat Agent graph.

    Parameters
    ----------
    runtime:
        ``AgentRuntime`` — provides tool definitions for ``bind_tools()``
        and executes ``tool_calls`` when the LLM requests them.
    llm:
        LangChain ``BaseChatModel`` that supports ``bind_tools()``.
    deps:
        ``ChatDeps`` implementation providing DB/context access.
    circuit_breaker:
        Optional ``CircuitBreaker`` for global failure tracking.

    Returns
    -------
    Compiled ``StateGraph``.
    """
    tool_defs = runtime.list_tool_defs()
    llm_with_tools = llm.bind_tools(tool_defs)

    _inject = as_error_node("inject_context")(inject_context)
    _agent = as_error_node("agent")(call_agent)
    _dispatch = as_error_node("runtime_dispatch")(runtime_dispatch)
    _format = as_error_node("format_result")(format_result)

    async def inject_node(s: ChatAgentState) -> dict:
        if circuit_breaker and circuit_breaker.is_tripped:
            return {"result": "", "error": "circuit breaker open"}
        return await _inject(
            s, deps=deps, runtime=runtime, skill_manager=skill_manager
        )

    async def agent_node(s: ChatAgentState) -> dict:
        return await _agent(s, llm_with_tools=llm_with_tools)

    async def dispatch_node(s: ChatAgentState) -> dict:
        return await _dispatch(s, runtime=runtime)

    async def error_n(s: ChatAgentState) -> dict:
        return await error_node(s)

    async def format_n(s: ChatAgentState) -> dict:
        return await _format(s)

    graph = StateGraph(ChatAgentState)

    graph.add_node("inject_context", inject_node)
    graph.add_node("agent", agent_node)
    graph.add_node("runtime_dispatch", dispatch_node)
    graph.add_node("error_node", error_n)
    graph.add_node("format_result", format_n)

    # ── edges ────────────────────────────────────────────────────────
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
            "format_result": "format_result",
        },
    )
    graph.add_conditional_edges(
        "error_node",
        route_after_error,
        {
            "inject_context": "inject_context",
            "agent": "agent",
            "runtime_dispatch": "runtime_dispatch",
            "format_result": "format_result",
        },
    )

    graph.add_edge("format_result", END)

    return graph.compile()


def create_chat_agent(**kwargs: Any) -> object:
    """Shorthand for ``build_chat_agent``."""
    return build_chat_agent(**kwargs)
