"""
Chat history service — hybrid MySQL + MongoDB storage.

MySQL ``chat_sessions`` stores session metadata (uid, title, status, timestamps)
keyed by a public ``chat_session_id`` (UUID4).

MongoDB ``chat_messages`` stores individual message documents keyed by ``msg_id``
(UUID4), scoped to a session via ``chat_session_id`` and to a user via ``uid``.

This mirrors the OpenAI approach: lightweight metadata in a relational database,
message content in a document store for flexible schema and efficient pagination.

Lifecycle of a message round-trip
----------------------------------
1. ``save_user_message()``       — inserts a completed user message in MongoDB
2. ``create_pending_assistant_message()`` — inserts a placeholder (status=pending)
3. ``complete_assistant_message()``       — fills content after LLM response
   (or ``fail_assistant_message()`` on error)
4. ``get_history_for_user()``    — paginated read, newest last
5. ``clear_history_for_user()``  — delete messages, keep session
6. ``delete_chat_session_for_user()`` — delete session + all messages
"""

import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

from loguru import logger
from sqlalchemy import select, desc, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ChatSession
from app.response.chat import ChatSessionResponse, ChatMessageResponse
from app.repository import mongo_chat_repository as mongo_chat


# ═══════════════════════════════════════════════════════════════════
# Session management — MySQL chat_sessions table
# ═══════════════════════════════════════════════════════════════════


async def create_chat_session(
    db: AsyncSession,
    uid: int,
    title: Optional[str] = None,
) -> ChatSessionResponse:
    """Create a new chat session for *uid*.

    Generates a UUID4 ``chat_session_id`` which serves as the public
    identifier and the MongoDB lookup key for messages.
    """
    chat_session_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)

    session = ChatSession(
        chat_session_id=chat_session_id,
        uid=uid,
        title=title,
        status="active",
        created_at=now,
        updated_at=now,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    logger.info(f"[CHAT_HISTORY] created session {chat_session_id} uid={uid}")
    return ChatSessionResponse.model_validate(session)


async def _unsafe_get_chat_session(
    db: AsyncSession,
    chat_session_id: str,
) -> Optional[ChatSessionResponse]:
    """Return a single session by its public *chat_session_id*, or None."""
    result = await db.execute(
        select(ChatSession).where(ChatSession.chat_session_id == chat_session_id)
    )
    session = result.scalar_one_or_none()
    if session is None:
        return None
    return ChatSessionResponse.model_validate(session)


async def get_chat_session_for_user(
    db: AsyncSession,
    uid: int,
    chat_session_id: str,
) -> Optional[ChatSessionResponse]:
    result = await db.execute(
        select(ChatSession).where(
            ChatSession.chat_session_id == chat_session_id,
            ChatSession.uid == uid,
        )
    )
    session = result.scalar_one_or_none()
    if session is None:
        return None
    return ChatSessionResponse.model_validate(session)


async def list_chat_sessions(
    db: AsyncSession,
    uid: int,
) -> list[ChatSessionResponse]:
    """Return all active sessions for a user, newest first.

    Cross-store consistency: if a session has 0 messages in MongoDB,
    soft-delete the MySQL row and exclude it from results.
    """
    result = await db.execute(
        select(ChatSession)
        .where(ChatSession.uid == uid, ChatSession.status == "active")
        .order_by(desc(ChatSession.updated_at))
    )
    sessions = result.scalars().all()

    valid = []
    grace_cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)
    for s in sessions:
        has_msgs = await mongo_chat.session_has_messages(s.chat_session_id)
        if not has_msgs and s.created_at:
            created = (
                s.created_at
                if s.created_at.tzinfo
                else s.created_at.replace(tzinfo=timezone.utc)
            )
            if created < grace_cutoff:
                s.status = "deleted"
                await db.commit()
                logger.info(
                    f"[CHAT_HISTORY] auto-cleaned stale session {s.chat_session_id}: no messages in MongoDB"
                )
                continue
        valid.append(ChatSessionResponse.model_validate(s))

    return valid


async def _unsafe_update_chat_session_title(
    db: AsyncSession,
    chat_session_id: str,
    title: str,
) -> None:
    """Update the session title.

    Typically called after the first user message to auto-generate
    a human-readable title from the question text.
    """
    result = await db.execute(
        select(ChatSession).where(ChatSession.chat_session_id == chat_session_id)
    )
    session = result.scalar_one_or_none()
    if session is None:
        logger.warning(f"[CHAT_HISTORY] update_title: not found {chat_session_id}")
        return
    session.title = title
    session.updated_at = datetime.now(timezone.utc)
    await db.commit()
    logger.info(f"[CHAT_HISTORY] updated title {chat_session_id}")


async def update_chat_session_title_for_user(
    db: AsyncSession,
    uid: int,
    chat_session_id: str,
    title: str,
) -> bool:
    result = await db.execute(
        select(ChatSession).where(
            ChatSession.chat_session_id == chat_session_id,
            ChatSession.uid == uid,
        )
    )
    session = result.scalar_one_or_none()
    if session is None:
        logger.warning(
            f"[CHAT_HISTORY] update_title: not found chat_session_id={chat_session_id} uid={uid}"
        )
        return False
    session.title = title
    session.updated_at = datetime.now(timezone.utc)
    await db.commit()
    logger.info(f"[CHAT_HISTORY] updated title {chat_session_id} uid={uid}")
    return True


async def touch_chat_session(
    db: AsyncSession,
    chat_session_id: str,
) -> None:
    """Bump ``updated_at`` and ``last_message_at`` to now.

    Called after every message to keep the session list sorted correctly.
    """
    result = await db.execute(
        select(ChatSession).where(ChatSession.chat_session_id == chat_session_id)
    )
    session = result.scalar_one_or_none()
    if session is None:
        return
    now = datetime.now(timezone.utc)
    session.updated_at = now
    session.last_message_at = now
    await db.commit()


async def _unsafe_delete_chat_session(
    db: AsyncSession,
    chat_session_id: str,
) -> None:
    """Delete a session row from MySQL and all its messages from MongoDB."""
    await mongo_chat._unsafe_delete_session_messages(chat_session_id)
    await db.execute(
        delete(ChatSession).where(ChatSession.chat_session_id == chat_session_id)
    )
    await db.commit()
    logger.info(f"[CHAT_HISTORY] deleted session {chat_session_id}")


async def delete_chat_session_for_user(
    db: AsyncSession,
    uid: int,
    chat_session_id: str,
) -> bool:
    session = await get_chat_session_for_user(db, uid, chat_session_id)
    if session is None:
        logger.warning(
            f"[CHAT_HISTORY] delete_session: not found chat_session_id={chat_session_id} uid={uid}"
        )
        return False
    await mongo_chat.delete_session_messages_for_user(chat_session_id, uid)
    await db.execute(
        delete(ChatSession).where(
            ChatSession.chat_session_id == chat_session_id,
            ChatSession.uid == uid,
        )
    )
    await db.commit()
    logger.info(f"[CHAT_HISTORY] deleted session {chat_session_id} uid={uid}")
    return True


# ═══════════════════════════════════════════════════════════════════
# Message management — MongoDB chat_messages collection
# ═══════════════════════════════════════════════════════════════════


def _messages_from_rows(rows: list[dict]) -> list[ChatMessageResponse]:
    return [
        ChatMessageResponse(
            msg_id=r.get("msg_id", ""),
            chat_session_id=r.get("chat_session_id", ""),
            role=r.get("role", ""),
            content=r.get("content", ""),
            status=r.get("status", "completed"),
            sources=r.get("sources"),
            tokens_used=r.get("tokens_used"),
            model=r.get("model"),
            latency_ms=r.get("latency_ms"),
            error=r.get("error"),
            created_at=r.get("created_at", datetime.now(timezone.utc)),
        )
        for r in rows
    ]


async def save_user_message(
    db: AsyncSession,
    chat_session_id: str,
    uid: int,
    content: str,
    sources: Optional[list[dict]] = None,
) -> ChatMessageResponse:
    """Persist a completed user message in MongoDB.

    Returns a ``ChatMessageResponse`` carrying the generated ``msg_id``
    so the caller can reference it later (e.g. for the pending assistant
    counterpart).
    """
    msg_id = await mongo_chat.insert_message(
        chat_session_id=chat_session_id,
        uid=uid,
        role="user",
        content=content,
        status="completed",
        sources=sources,
    )
    return ChatMessageResponse(
        msg_id=msg_id,
        chat_session_id=chat_session_id,
        role="user",
        content=content,
        status="completed",
        sources=sources,
        created_at=datetime.now(timezone.utc),
    )


async def create_pending_assistant_message(
    db: AsyncSession,
    chat_session_id: str,
    uid: int,
    model: Optional[str] = None,
) -> ChatMessageResponse:
    """Insert a placeholder assistant message (status=pending, content="")
    and return its ``msg_id`` for the streaming completion callback.
    """
    msg_id = await mongo_chat.insert_message(
        chat_session_id=chat_session_id,
        uid=uid,
        role="assistant",
        content="",
        status="pending",
        model=model,
    )
    return ChatMessageResponse(
        msg_id=msg_id,
        chat_session_id=chat_session_id,
        role="assistant",
        content="",
        status="pending",
        model=model,
        created_at=datetime.now(timezone.utc),
    )


async def complete_assistant_message(
    db: AsyncSession,
    msg_id: str,
    content: str,
    sources: Optional[list[dict]] = None,
    tokens_used: Optional[int] = None,
    latency_ms: Optional[int] = None,
) -> None:
    """Finalise a pending assistant message after the LLM response arrives.

    Updates the MongoDB document in-place: sets status=completed, fills
    content / sources / tokens_used / latency_ms.
    """
    await mongo_chat.update_message_content(
        msg_id,
        content=content,
        sources=sources,
        tokens_used=tokens_used,
        latency_ms=latency_ms,
    )
    logger.info(
        f"[CHAT_HISTORY] completed assistant msg_id={msg_id} len={len(content)}"
    )


async def fail_assistant_message(
    db: AsyncSession,
    msg_id: str,
    error: str,
) -> None:
    """Mark a pending assistant message as failed with *error* text."""
    await mongo_chat.fail_message(msg_id, error)
    logger.warning(f"[CHAT_HISTORY] failed assistant msg_id={msg_id}")


async def _unsafe_get_history(
    db: AsyncSession,
    chat_session_id: str,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[ChatMessageResponse], int]:
    """Return paginated messages for a session from MongoDB.

    Messages are sorted by ``created_at`` ascending (chronological order).
    Returns ``(messages, total_count)``.
    """
    rows, total = await mongo_chat._unsafe_get_messages(
        chat_session_id, page=page, page_size=page_size
    )
    messages = _messages_from_rows(rows)
    return messages, total


async def get_history_for_user(
    db: AsyncSession,
    uid: int,
    chat_session_id: str,
    page: int = 1,
    page_size: int = 50,
) -> Optional[tuple[list[ChatMessageResponse], int]]:
    session = await get_chat_session_for_user(db, uid, chat_session_id)
    if session is None:
        return None
    rows, total = await mongo_chat.get_messages_for_user(
        chat_session_id, uid, page=page, page_size=page_size
    )
    return _messages_from_rows(rows), total


async def _unsafe_clear_history(
    db: AsyncSession,
    chat_session_id: str,
) -> None:
    """Delete all messages belonging to *chat_session_id* from MongoDB.

    The session row in MySQL is kept intact — only messages are removed.
    """
    deleted = await mongo_chat._unsafe_delete_session_messages(chat_session_id)
    logger.info(f"[CHAT_HISTORY] cleared {deleted} messages from {chat_session_id}")


async def clear_history_for_user(
    db: AsyncSession,
    uid: int,
    chat_session_id: str,
) -> bool:
    session = await get_chat_session_for_user(db, uid, chat_session_id)
    if session is None:
        return False
    deleted = await mongo_chat.delete_session_messages_for_user(chat_session_id, uid)
    logger.info(
        f"[CHAT_HISTORY] cleared {deleted} messages from {chat_session_id} uid={uid}"
    )
    return True


# ═══════════════════════════════════════════════════════════════════
# Convenience
# ═══════════════════════════════════════════════════════════════════


async def get_or_create_chat_session(
    db: AsyncSession,
    uid: int,
    chat_session_id: Optional[str] = None,
    title: Optional[str] = None,
) -> ChatSessionResponse:
    """Return an existing session by *chat_session_id*, or create a new one.

    Used by the chat endpoints to transparently reuse an ongoing
    conversation or start a fresh one on the first message.
    """
    if chat_session_id:
        existing = await get_chat_session_for_user(db, uid, chat_session_id)
        if existing:
            return existing

    return await create_chat_session(db, uid=uid, title=title)
