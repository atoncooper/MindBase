"""
MongoDB repository for code execution records.

Each ``run_code`` invocation (success, failure, or timeout) by the Code
Agent is persisted here as one document in the ``code_executions``
collection, enabling post-hoc review from the admin console and from a
chat message's detail view.

Collection: code_executions
Document:
    {
        "exec_id":           str (UUID4),
        "uid":               int,
        "chat_session_id":   str (UUID4),   // FK -> MySQL chat_sessions
        "assistant_msg_id":  str (UUID4),   // FK -> MongoDB chat_messages.msg_id
        "delegate_query":    str,           // sub-query that triggered the code agent
        "code":              str,           // full source (untruncated)
        "language":          str,           // "python" | "javascript" | "typescript"
        "stdout":            str,           // full stdout (untruncated)
        "exit_code":         int,
        "latency_ms":        int,
        "error":             str | null,    // failure message (null on success)
        "timeout":           bool,          // true if execution hit the per-step timeout
        "artifacts": [                      // extracted binary artifacts (e.g. images)
            {"name": str, "minio_key": str, "url": str,
             "content_type": str, "size": int}
        ],
        "artifact_count":    int,           // denormalised len(artifacts) for cheap listing
        "created_at":        datetime,
    }
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from loguru import logger
from pymongo import ASCENDING, DESCENDING

from app.infra.mongo import coll, is_enabled

COLLECTION = "code_executions"

# Fields excluded from list responses to keep payloads small; full code and
# stdout are only returned by the single-record detail endpoint.
_LIST_EXCLUSION = {"code": 0, "stdout": 0, "artifacts": 0}


def _new_exec_id() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Write ops ──────────────────────────────────────────────────────


async def insert(
    *,
    uid: int,
    chat_session_id: str,
    assistant_msg_id: str,
    delegate_query: str,
    code: str,
    language: str,
    stdout: str,
    exit_code: int,
    latency_ms: int,
    error: Optional[str] = None,
    timeout: bool = False,
    artifacts: Optional[list[dict]] = None,
) -> str:
    """Insert one execution record and return its ``exec_id``.

    When Mongo is disabled the record is dropped (a fresh ``exec_id`` is
    still returned so callers can reference it), mirroring
    ``mongo_chat_repository.insert_message``.
    """
    exec_id = _new_exec_id()
    safe_artifacts = artifacts or []
    doc: dict[str, Any] = {
        "exec_id": exec_id,
        "uid": uid,
        "chat_session_id": chat_session_id,
        "assistant_msg_id": assistant_msg_id,
        "delegate_query": delegate_query,
        "code": code,
        "language": language,
        "stdout": stdout,
        "exit_code": exit_code,
        "latency_ms": latency_ms,
        "error": error,
        "timeout": timeout,
        "artifacts": safe_artifacts,
        "artifact_count": len(safe_artifacts),
        "created_at": _now(),
    }
    if not is_enabled():
        logger.warning("[CODE_EXEC] mongo disabled - record not persisted")
        return exec_id

    await coll(COLLECTION).insert_one(doc)
    logger.debug(
        "[CODE_EXEC] inserted exec_id={} exit_code={} artifacts={}",
        exec_id, exit_code, len(safe_artifacts),
    )
    return exec_id


# ── Read ops ───────────────────────────────────────────────────────


async def get(
    exec_id: str,
    *,
    uid: Optional[int] = None,
) -> Optional[dict]:
    """Return the full record (including code/stdout/artifacts).

    When ``uid`` is given the record is filtered by owner so a foreign
    user gets ``None`` (callers should surface this as 404, not 403, to
    avoid leaking existence). ``uid=None`` skips ownership checks and is
    intended for admin endpoints.
    """
    if not is_enabled():
        return None
    query: dict[str, Any] = {"exec_id": exec_id}
    if uid is not None:
        query["uid"] = uid
    return await coll(COLLECTION).find_one(query)


async def list_by_msg(
    assistant_msg_id: str,
    uid: int,
    *,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[dict], int]:
    """Paginated executions for one assistant message, oldest first."""
    query: dict[str, Any] = {"assistant_msg_id": assistant_msg_id, "uid": uid}
    return await _list(query, page=page, page_size=page_size, sort=ASCENDING)


async def list_by_session(
    chat_session_id: str,
    uid: int,
    *,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[dict], int]:
    """Paginated executions for one chat session, oldest first."""
    query: dict[str, Any] = {"chat_session_id": chat_session_id, "uid": uid}
    return await _list(query, page=page, page_size=page_size, sort=ASCENDING)


async def list_for_admin(
    *,
    uid: Optional[int] = None,
    chat_session_id: Optional[str] = None,
    assistant_msg_id: Optional[str] = None,
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[dict], int]:
    """Admin listing with optional filters, newest first.

    All filters are optional; omitting them returns the global newest-first
    stream. Ownership is intentionally not checked (admin scope).
    """
    query: dict[str, Any] = {}
    if uid is not None:
        query["uid"] = uid
    if chat_session_id:
        query["chat_session_id"] = chat_session_id
    if assistant_msg_id:
        query["assistant_msg_id"] = assistant_msg_id
    if since or until:
        created: dict[str, Any] = {}
        if since:
            created["$gte"] = since
        if until:
            created["$lte"] = until
        query["created_at"] = created
    return await _list(query, page=page, page_size=page_size, sort=DESCENDING)


async def _list(
    query: dict[str, Any],
    *,
    page: int,
    page_size: int,
    sort: int,
) -> tuple[list[dict], int]:
    """Shared paginated list - excludes heavy code/stdout/artifacts fields."""
    if not is_enabled():
        return [], 0
    total = await coll(COLLECTION).count_documents(query)
    cursor = (
        coll(COLLECTION)
        .find(query, _LIST_EXCLUSION)
        .sort("created_at", sort)
        .skip(max(0, (page - 1) * page_size))
        .limit(page_size)
    )
    rows = await cursor.to_list(length=page_size)
    return rows, total


# ── Delete ops ─────────────────────────────────────────────────────


async def delete(exec_id: str) -> int:
    """Delete one record by ``exec_id``. Returns deleted count (0 if missing).

    Only the Mongo document is removed here. MinIO artifact objects should
    be cleaned up by the caller (service layer) using the artifact
    ``minio_key`` values fetched before deletion - this keeps the
    repository a pure data-access layer with no cross-store coupling.
    """
    if not is_enabled():
        return 0
    result = await coll(COLLECTION).delete_one({"exec_id": exec_id})
    if result.deleted_count:
        logger.info("[CODE_EXEC] deleted exec_id={}", exec_id)
    return result.deleted_count


async def delete_for_owner(exec_id: str, uid: int) -> int:
    """Delete a record only if it belongs to ``uid``. Returns deleted count."""
    if not is_enabled():
        return 0
    result = await coll(COLLECTION).delete_one({"exec_id": exec_id, "uid": uid})
    if result.deleted_count:
        logger.info("[CODE_EXEC] deleted exec_id={} uid={}", exec_id, uid)
    return result.deleted_count
