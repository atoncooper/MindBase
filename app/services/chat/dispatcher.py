"""Dispatcher — bridges the chat orchestrator to ``AgentHarness``.

Resolves search scope from the request, then forwards to
``AgentHarness.dispatch`` / ``dispatch_stream``.  This is the single
entry point all chat endpoints share, so routing/observability/limits
stay consistent across `/ask`, `/ask/agentic`, `/ask/stream`,
`/ask/agent`, and `/ask/agent/stream`.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import HTTPException
from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.response import ChatRequest
from app.services import chat_history as chat_history_service
from app.services.chat.scope import (
    get_bvids_by_media_ids,
    get_media_ids_for_uid,
)


def _ensure_started(agent_harness: Any) -> None:
    if not agent_harness or not getattr(agent_harness, "started", False):
        raise HTTPException(
            status_code=503,
            detail="Agent 服务暂不可用，请稍后再试",
        )


async def _resolve_agent_context(
    request: ChatRequest, *, db: AsyncSession, uid: int
) -> dict[str, Any]:
    """Compute the bvids/media_ids/workspace_pages triple the agent expects.

    If no explicit scope is given (no folder_ids/workspace_id/workspace_pages),
    inherit the source scope from the last assistant turn: automatically narrow
    vector search to the exact documents the user already saw in the conversation.
    """
    has_explicit_scope = bool(
        request.folder_ids
        or request.workspace_id is not None
        or request.workspace_pages
    )

    media_ids = await get_media_ids_for_uid(db, uid, request.folder_ids)
    bvids = await get_bvids_by_media_ids(db, media_ids) if media_ids else []
    workspace_pages: Optional[list[dict]] = (
        [wp.model_dump() for wp in request.workspace_pages]
        if request.workspace_pages
        else None
    )

    # Inherit scope from last turn when no explicit scope given
    inherited_uuids: Optional[list[str]] = None
    if not has_explicit_scope:
        last_uuids, last_bvids = await chat_history_service.get_last_assistant_sources(
            request.chat_session_id, uid
        )
        if last_uuids:
            inherited_uuids = last_uuids
            logger.info(
                "[CHAT_SCOPE] inherited {} cloud docs from last turn: session_id={}",
                len(last_uuids),
                request.chat_session_id[:8],
            )
        if last_bvids and not bvids:
            bvids = last_bvids
            logger.info(
                "[CHAT_SCOPE] inherited {} videos from last turn: session_id={}",
                len(last_bvids),
                request.chat_session_id[:8],
            )

    return {
        "bvids": bvids,
        "media_ids": media_ids,
        "workspace_pages": workspace_pages,
        "upload_uuids": inherited_uuids,
    }


async def agent_run(
    request: ChatRequest,
    *,
    uid: int,
    db: AsyncSession,
    agent_harness: Any,
    session_id: str,
    query: str,
    callbacks: Optional[list[Any]] = None,
) -> dict[str, Any]:
    """Dispatch a non-streaming agent run.

    Returns the agent output dict (``result``, ``messages``, ``sources``,
    ``error``).  Raises ``HTTPException(503)`` when the harness is not
    started.
    """
    _ensure_started(agent_harness)
    ctx = await _resolve_agent_context(request, db=db, uid=uid)

    invoke_kwargs: dict[str, Any] = dict(
        uid=uid,
        bvids=ctx["bvids"],
        media_ids=ctx["media_ids"],
        workspace_pages=ctx["workspace_pages"],
        folder_ids=request.folder_ids or [],
        upload_uuids=ctx["upload_uuids"],
    )
    if callbacks:
        invoke_kwargs["callbacks"] = callbacks

    return await agent_harness.dispatch(
        session_id=session_id,
        query=query,
        **invoke_kwargs,
    )


async def agent_stream_setup(
    request: ChatRequest,
    *,
    uid: int,
    db: AsyncSession,
    agent_harness: Any,
    session_id: str,
    query: str,
) -> tuple[str, Any, dict[str, Any], dict[str, Any]]:
    """Run the routing decision and prepare a streaming graph invocation.

    Returns ``(agent_name, compiled_graph, input_state, run_config)``.  The
    caller drives ``compiled_graph.astream_events(input_state, run_config)``.
    """
    _ensure_started(agent_harness)
    ctx = await _resolve_agent_context(request, db=db, uid=uid)

    agent_name, agent_graph = await agent_harness.dispatch_stream(
        session_id=session_id,
        query=query,
        uid=uid,
        bvids=ctx["bvids"],
        media_ids=ctx["media_ids"],
        workspace_pages=ctx["workspace_pages"],
        folder_ids=request.folder_ids or [],
        upload_uuids=ctx["upload_uuids"],
    )

    input_state: dict[str, Any] = {
        "query": query,
        "session_id": session_id,
        "uid": uid,
        "folder_ids": request.folder_ids or [],
        "bvids": ctx["bvids"],
        "media_ids": ctx["media_ids"],
        "workspace_pages": ctx["workspace_pages"] or [],
        "upload_uuids": ctx["upload_uuids"] or [],
    }
    run_config: dict[str, Any] = {
        "run_name": f"{agent_name}_agent_stream",
        "tags": [f"{agent_name}_agent", "streaming"],
        "metadata": {
            "agent_name": agent_name,
            "session_id": session_id,
            "uid": uid,
        },
    }
    return agent_name, agent_graph, input_state, run_config
