"""Session summary service — button-triggered detailed conversation summaries.

Orchestrates the ``summary`` agent (registered in the AgentHarness lifecycle,
NOT a chat route target). Layering mirrors the chat orchestrator:

* ``prepare_summary`` — ownership / non-empty / harness checks. Runs BEFORE
  the StreamingResponse starts, so failures surface as real HTTP status
  codes (404 / 400 / 503) instead of a broken SSE stream.
* ``stream_summary`` — pure SSE generator (``chunk`` / ``done`` / ``error``
  frames). Accumulates streamed tokens, captures the agent's final state
  from the root ``on_chain_end`` event (same technique as AgentSSEStreamer)
  and persists the finished summary to MongoDB ``session_summaries``.
* ``get_latest_summary`` — newest persisted summary for a session.
* ``get_or_create_summary`` — non-streaming entry reused by quiz-from-summary
  generation; persists its result so both features share one summary.

The pooled agent is acquired under an independent session key
(``summary:<chat_session_id>``) so a concurrent chat turn on the same
session never contends for the lifecycle session lock.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator, Optional

from fastapi import HTTPException
from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.repository import mongo_chat_repository as mongo_chat
from app.repository import mongo_summary_repository as mongo_summary
from app.services import chat_history as chat_history_service

DEFAULT_QUERY = "请总结当前会话"


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def prepare_summary(
    db: AsyncSession,
    uid: int,
    chat_session_id: str,
    agent_harness: Any,
) -> tuple[Any, dict[str, Any], dict[str, Any]]:
    """Validate the request and resolve the pooled summary agent.

    Returns ``(agent_graph, input_state, run_config)`` for ``stream_summary``.
    Raises HTTPException(404/400/503) — must be called before the streaming
    response begins.
    """
    session = await chat_history_service.get_chat_session_for_user(
        db, uid, chat_session_id
    )
    if session is None:
        raise HTTPException(status_code=404, detail="会话不存在")

    if not await mongo_chat.session_has_messages(chat_session_id):
        raise HTTPException(status_code=400, detail="会话暂无消息，无法总结")

    if not (agent_harness and getattr(agent_harness, "started", False)):
        raise HTTPException(status_code=503, detail="Agent 服务未启动")

    agent = await agent_harness.lifecycle.get_agent(
        "summary", f"summary:{chat_session_id}"
    )
    input_state: dict[str, Any] = {
        "chat_session_id": chat_session_id,
        "uid": uid,
        "query": DEFAULT_QUERY,
    }
    run_config: dict[str, Any] = {
        "run_name": "summary_agent_stream",
        "tags": ["summary_agent", "streaming"],
        "metadata": {
            "agent_name": "summary",
            "chat_session_id": chat_session_id,
            "uid": uid,
        },
    }
    return agent, input_state, run_config


async def _insert_summary_record(
    uid: int,
    chat_session_id: str,
    content: str,
    final_state: dict[str, Any],
) -> tuple[Optional[str], int]:
    """Persist a finished summary; return ``(summary_id, message_count)``.

    Shared by the SSE flow (content = streamed tokens) and the non-streaming
    ``get_or_create_summary`` path (content = agent result). Persistence
    failure raises — callers decide how to surface it.
    """
    message_count = int(final_state.get("message_count") or 0)
    summary_id = await mongo_summary.insert_summary(
        chat_session_id=chat_session_id,
        uid=uid,
        content=content,
        message_count=message_count,
        first_message_at=final_state.get("first_message_at"),
        last_message_at=final_state.get("last_message_at"),
    )
    return summary_id, message_count


async def get_or_create_summary(
    uid: int,
    chat_session_id: str,
    agent_harness: Any,
) -> str:
    """Return the latest persisted summary content, generating one if absent.

    Non-streaming counterpart to the SSE summary flow, used by
    quiz-from-summary generation: when no persisted summary exists the
    registered ``summary`` agent is invoked via the lifecycle and its result
    is persisted, so the summary modal (GET latest) shows the same document
    afterwards — both features share one summary per session.

    Raises RuntimeError when the agent fails or produces no usable content.
    """
    latest = await mongo_summary.get_latest_summary_for_user(chat_session_id, uid)
    if latest and str(latest.get("content") or "").strip():
        return str(latest["content"])

    from app.agent.summary.prompts import EMPTY_RESULT, FALLBACK_RESULT

    result_state = await agent_harness.lifecycle.invoke(
        "summary",
        f"summary:{chat_session_id}",
        timeout=120.0,
        chat_session_id=chat_session_id,
        uid=uid,
        query=DEFAULT_QUERY,
    )
    result_state = result_state or {}
    error = str(result_state.get("error") or "").strip()
    if error:
        raise RuntimeError(f"会话总结生成失败: {error[:200]}")

    content = str(result_state.get("result") or "").strip()
    if not content or content in (FALLBACK_RESULT, EMPTY_RESULT):
        raise RuntimeError("会话总结生成失败，请稍后重试")

    try:
        await _insert_summary_record(uid, chat_session_id, content, result_state)
    except Exception:
        # The content itself is usable; persistence failure must not abort
        # quiz generation — the modal simply won't see this summary.
        logger.exception(
            "[SESSION_SUMMARY] persist (non-stream) failed session=%s",
            chat_session_id[:8],
        )
    return content


async def stream_summary(
    agent: Any,
    input_state: dict[str, Any],
    run_config: dict[str, Any],
    *,
    uid: int,
    chat_session_id: str,
) -> AsyncIterator[str]:
    """Stream the summary agent as SSE frames; persist on success.

    Never raises — any failure after the response started is reported as an
    ``error`` frame so the frontend can recover.
    """
    accumulated = ""
    final_state: dict[str, Any] = {}
    root_run_name = run_config.get("run_name", "LangGraph")

    try:
        async for event in agent.astream_events(input_state, config=run_config, version="v2"):
            kind = event.get("event", "")
            if kind == "on_chat_model_stream":
                chunk = event.get("data", {}).get("chunk")
                text = getattr(chunk, "content", "") if chunk is not None else ""
                if text:
                    accumulated += text
                    yield _sse({"type": "chunk", "content": text})
            elif kind == "on_chain_end" and event.get("name") == root_run_name:
                output = event.get("data", {}).get("output")
                if isinstance(output, dict):
                    final_state = output
    except Exception as exc:
        logger.exception("[SESSION_SUMMARY] stream failed session=%s", chat_session_id[:8])
        yield _sse({"type": "error", "message": str(exc)})
        return

    if not accumulated.strip():
        # No tokens streamed: the agent short-circuited (empty history at
        # agent level, circuit breaker open, or retries exhausted) — report
        # its result/error text instead of persisting an empty summary.
        result = str(final_state.get("result") or "")
        error = str(final_state.get("error") or "")
        yield _sse({"type": "error", "message": result or error or "总结生成失败"})
        return

    try:
        summary_id, message_count = await _insert_summary_record(
            uid, chat_session_id, accumulated.strip(), final_state
        )
    except Exception:
        # The summary itself reached the user; a persistence failure must
        # not discard it — report via done frame without a summary_id.
        logger.exception(
            "[SESSION_SUMMARY] persist failed session=%s", chat_session_id[:8]
        )
        yield _sse({"type": "done", "summary_id": None, "message_count": message_count})
        return

    yield _sse({"type": "done", "summary_id": summary_id, "message_count": message_count})


async def get_latest_summary(
    db: AsyncSession,
    uid: int,
    chat_session_id: str,
) -> Optional[dict[str, Any]]:
    """Return the newest persisted summary document, or None."""
    session = await chat_history_service.get_chat_session_for_user(
        db, uid, chat_session_id
    )
    if session is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    return await mongo_summary.get_latest_summary_for_user(chat_session_id, uid)
