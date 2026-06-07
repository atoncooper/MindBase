"""
MongoDB repository for chat messages.

Each message is one document in the ``chat_messages`` collection.
Sessions are stored in MySQL (chat_sessions) — only message content lives here.

Collection: chat_messages
Document:
    {
        "msg_id":           str (UUID4),
        "chat_session_id":  str (UUID4),   // FK → MySQL chat_sessions.chat_session_id
        "uid":              int,
        "role":             "user" | "assistant" | "system",
        "content":          str,
        "status":           "pending" | "completed" | "failed",
        "sources":          [dict] | null,
        "tokens_used":      int | null,
        "model":            str | null,
        "latency_ms":        int | null,
        "error":            str | null,
        "created_at":        datetime,
    }
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from loguru import logger

from app.infra.mongo import coll, is_enabled

COLLECTION = "chat_messages"


def _new_msg_id() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Write ops ──────────────────────────────────────────────────────

async def insert_message(
    *,
    chat_session_id: str,
    uid: int,
    role: str,
    content: str,
    status: str = "completed",
    sources: Optional[list[dict]] = None,
    tokens_used: Optional[int] = None,
    model: Optional[str] = None,
    latency_ms: Optional[int] = None,
    error: Optional[str] = None,
) -> str:
    """Insert a message and return its msg_id."""
    msg_id = _new_msg_id()
    doc: dict[str, Any] = {
        "msg_id": msg_id,
        "chat_session_id": chat_session_id,
        "uid": uid,
        "role": role,
        "content": content,
        "status": status,
        "sources": sources,
        "tokens_used": tokens_used,
        "model": model,
        "latency_ms": latency_ms,
        "error": error,
        "created_at": _now(),
    }
    if not is_enabled():
        logger.warning("[MONGO_CHAT] mongo disabled — message not persisted")
        return msg_id

    await coll(COLLECTION).insert_one(doc)
    logger.debug(f"[MONGO_CHAT] inserted msg_id={msg_id} role={role}")
    return msg_id


async def update_message_content(msg_id: str, *, content: str, **fields: Any) -> None:
    """Update an existing message (used to finalise pending assistant msg)."""
    if not is_enabled():
        return
    set_fields = {"content": content, "status": "completed", **fields}
    result = await coll(COLLECTION).update_one(
        {"msg_id": msg_id}, {"$set": set_fields}
    )
    if result.matched_count == 0:
        logger.warning(f"[MONGO_CHAT] update_message_content: msg_id={msg_id} not found")


async def fail_message(msg_id: str, error: str) -> None:
    """Mark a pending assistant message as failed."""
    if not is_enabled():
        return
    await coll(COLLECTION).update_one(
        {"msg_id": msg_id},
        {"$set": {"status": "failed", "error": error}},
    )


# ── Read ops ───────────────────────────────────────────────────────

async def get_messages(
    chat_session_id: str,
    *,
    page: int = 1,
    page_size: int = 50,
    before_msg_id: Optional[str] = None,
) -> tuple[list[dict], int]:
    """Paginated messages for a session, oldest first (chat order)."""
    if not is_enabled():
        return [], 0

    query: dict[str, Any] = {"chat_session_id": chat_session_id}
    if before_msg_id:
        query["msg_id"] = {"$lt": before_msg_id}

    total = await coll(COLLECTION).count_documents(query)

    cursor = (
        coll(COLLECTION)
        .find(query)
        .sort("created_at", 1)
        .skip((page - 1) * page_size)
        .limit(page_size)
    )
    rows = await cursor.to_list(length=page_size)
    return rows, total


async def session_has_messages(chat_session_id: str) -> bool:
    """Check if a session has at least one message in MongoDB."""
    if not is_enabled():
        return True  # MongoDB disabled → trust MySQL
    count = await coll(COLLECTION).count_documents({"chat_session_id": chat_session_id}, limit=1)
    return count > 0


async def delete_session_messages(chat_session_id: str) -> int:
    """Delete all messages belonging to a session. Returns deleted count."""
    if not is_enabled():
        return 0
    result = await coll(COLLECTION).delete_many({"chat_session_id": chat_session_id})
    logger.info(
        f"[MONGO_CHAT] deleted {result.deleted_count} messages "
        f"for chat_session_id={chat_session_id}"
    )
    return result.deleted_count
