"""
MongoDB repository for chat session summaries.

Each summary is one document in the ``session_summaries`` collection.
Summaries are produced by the summary agent (frontend button, not chat
routing) and stored SEPARATELY from ``chat_messages`` — a summary must
never become part of the conversation it summarizes (it would pollute
later summaries and context compression). The latest summary per session
is intended to be reused as quiz-generation material.

Re-generating a summary appends a new document; readers take the latest
by ``created_at`` (simple versioning, old summaries are kept).

Collection: session_summaries
Document:
    {
        "summary_id":       str (UUID4, unique),
        "chat_session_id":  str (UUID4),   // FK → MySQL chat_sessions.chat_session_id
        "uid":              int,
        "content":          str,           // Markdown summary
        "message_count":    int,           // messages covered by this summary
        "first_message_at": datetime | None,
        "last_message_at":  datetime | None,
        "created_at":       datetime,
    }
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from loguru import logger

from app.infra.mongo import coll, is_enabled

COLLECTION = "session_summaries"


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Write ops ──────────────────────────────────────────────────────


async def insert_summary(
    *,
    chat_session_id: str,
    uid: int,
    content: str,
    message_count: int = 0,
    first_message_at: Optional[datetime] = None,
    last_message_at: Optional[datetime] = None,
) -> str:
    """Insert a summary and return its summary_id."""
    summary_id = str(uuid.uuid4())
    doc: dict[str, Any] = {
        "summary_id": summary_id,
        "chat_session_id": chat_session_id,
        "uid": uid,
        "content": content,
        "message_count": message_count,
        "first_message_at": first_message_at,
        "last_message_at": last_message_at,
        "created_at": _now(),
    }
    if not is_enabled():
        logger.warning("[MONGO_SUMMARY] mongo disabled — summary not persisted")
        return summary_id

    await coll(COLLECTION).insert_one(doc)
    logger.info(
        f"[MONGO_SUMMARY] inserted summary_id={summary_id} "
        f"session={chat_session_id[:8]} messages={message_count}"
    )
    return summary_id


# ── Read ops ───────────────────────────────────────────────────────


async def get_latest_summary_for_user(
    chat_session_id: str,
    uid: int,
) -> Optional[dict[str, Any]]:
    """Return the newest summary document for the session, or None."""
    if not is_enabled():
        return None
    return await coll(COLLECTION).find_one(
        {"chat_session_id": chat_session_id, "uid": uid},
        sort=[("created_at", -1)],
    )
