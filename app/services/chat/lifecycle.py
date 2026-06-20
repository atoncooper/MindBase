"""Chat-turn lifecycle helpers.

Wraps the user-message + assistant-placeholder + session-touch ritual that
every chat endpoint must perform before invoking the harness.
"""

from dataclasses import dataclass
from typing import Optional

from fastapi import BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.response import ChatSessionResponse
from app.services import chat_history as chat_history_service
from app.services.chat.llm import build_llm
from app.services.chat.title_scheduling import schedule_title_generation


@dataclass(frozen=True)
class TurnContext:
    """Per-turn state shared between router and orchestrator."""

    chat_session: ChatSessionResponse
    chat_session_id: str
    user_message: str
    assistant_msg_id: str


async def begin_turn(
    db: AsyncSession,
    *,
    uid: int,
    chat_session_id: Optional[str],
    question: str,
    background_tasks: BackgroundTasks,
) -> TurnContext:
    """Open or reuse a chat session and stage user + assistant messages."""
    chat_session = await chat_history_service.get_or_create_chat_session(
        db, uid=uid, chat_session_id=chat_session_id,
    )
    user_message = question.strip()

    await chat_history_service.save_user_message(
        db, chat_session.chat_session_id, uid, user_message
    )
    schedule_title_generation(
        background_tasks,
        chat_session,
        uid=uid,
        first_message=user_message,
        llm_factory=build_llm,
    )
    assistant_msg = await chat_history_service.create_pending_assistant_message(
        db, chat_session.chat_session_id, uid, model=settings.llm_model
    )
    await chat_history_service.touch_chat_session(db, chat_session.chat_session_id)

    return TurnContext(
        chat_session=chat_session,
        chat_session_id=chat_session.chat_session_id,
        user_message=user_message,
        assistant_msg_id=assistant_msg.msg_id,
    )


async def finalize_turn(
    db: AsyncSession,
    *,
    assistant_msg_id: str,
    content: str,
    sources: list[dict],
    tokens_used: Optional[int],
    latency_ms: int,
) -> None:
    await chat_history_service.complete_assistant_message(
        db,
        msg_id=assistant_msg_id,
        content=content,
        sources=sources[:5],
        tokens_used=tokens_used,
        latency_ms=latency_ms,
    )


async def fail_turn(
    db: AsyncSession,
    *,
    assistant_msg_id: str,
    error: str,
) -> None:
    await chat_history_service.fail_assistant_message(
        db, assistant_msg_id, error=error
    )


async def cancel_turn(
    db: AsyncSession,
    *,
    assistant_msg_id: str,
) -> None:
    """Remove the pending assistant placeholder for a turn that never ran.

    Call this when setup failed *before* the agent produced anything
    (e.g. harness 503, scope resolution error).  Unlike :func:`fail_turn`,
    this leaves no trace in history — the user's question is preserved
    but no empty "failed" assistant bubble appears.
    """
    await chat_history_service.delete_assistant_message(db, assistant_msg_id)
