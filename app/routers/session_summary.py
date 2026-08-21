"""Session summary endpoints — generate / fetch chat-session summaries.

Mounted under the ``/chat`` prefix so APISIX's existing ``/chat/*`` SSE
route (no 30s read-timeout cut) applies unchanged; auth is the shared
Bearer bili_session (``get_current_uid``), same as every other ``/chat/*``
endpoint.

* ``POST /chat/sessions/{id}/summary`` — SSE stream a fresh detailed
  summary produced by the ``summary`` agent (frontend button).
* ``GET  /chat/sessions/{id}/summary`` — latest persisted summary
  (404 when none exists yet); intended for reuse by the quiz agent.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.response.chat import SessionSummaryResponse
from app.routers.auth import get_current_uid
from app.routers.streaming import sse_streaming_response
from app.services import session_summary as session_summary_service

router = APIRouter(prefix="/chat", tags=["会话总结"])


@router.post("/sessions/{chat_session_id}/summary")
async def summarize_session(
    chat_session_id: str,
    request: Request,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Stream a fresh detailed summary of the session (SSE: chunk/done/error)."""
    agent_harness = getattr(request.app.state, "agent_harness", None)
    agent, input_state, run_config = await session_summary_service.prepare_summary(
        db, uid, chat_session_id, agent_harness
    )
    return sse_streaming_response(
        session_summary_service.stream_summary(
            agent, input_state, run_config, uid=uid, chat_session_id=chat_session_id
        )
    )


@router.get(
    "/sessions/{chat_session_id}/summary",
    response_model=SessionSummaryResponse,
)
async def get_session_summary(
    chat_session_id: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Return the latest persisted summary (404 when none exists yet)."""
    doc = await session_summary_service.get_latest_summary(db, uid, chat_session_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="该会话暂无总结")
    return SessionSummaryResponse(
        summary_id=doc["summary_id"],
        chat_session_id=doc["chat_session_id"],
        content=doc.get("content", ""),
        message_count=doc.get("message_count") or 0,
        first_message_at=doc.get("first_message_at"),
        last_message_at=doc.get("last_message_at"),
        created_at=doc["created_at"],
    )
