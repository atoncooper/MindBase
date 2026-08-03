"""Service layer for code execution records.

Thin orchestration over ``code_execution_repository``. The only cross-store
logic is ``delete_for_admin`` (which also removes MinIO artifacts); every
read op delegates straight to the repository so router code stays a pure
parameter-parsing layer per the project's layering rules.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from loguru import logger

from app.infra.minio import get_minio_client
from app.infra.minio import is_enabled as minio_enabled
from app.repository import code_execution_repository as repo


async def list_for_user(
    msg_id: str, uid: int, *, page: int = 1, page_size: int = 50
) -> tuple[list[dict], int]:
    """Executions for one assistant message, scoped to ``uid``."""
    return await repo.list_by_msg(msg_id, uid, page=page, page_size=page_size)


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
    """Admin listing with optional filters (ownership not checked)."""
    return await repo.list_for_admin(
        uid=uid,
        chat_session_id=chat_session_id,
        assistant_msg_id=assistant_msg_id,
        since=since,
        until=until,
        page=page,
        page_size=page_size,
    )


async def get_for_user(exec_id: str, uid: int) -> Optional[dict]:
    """Full record, scoped to ``uid`` (returns None for foreign records)."""
    return await repo.get(exec_id, uid=uid)


async def get_for_admin(exec_id: str) -> Optional[dict]:
    """Full record, no ownership check (admin scope)."""
    return await repo.get(exec_id, uid=None)


async def delete_for_admin(exec_id: str) -> int:
    """Delete a record and its MinIO artifacts. Returns deleted count.

    MinIO cleanup is best-effort: a failed object delete is logged but does
    not abort the Mongo record deletion (the record is the source of truth
    for "this execution happened"; orphaned objects are a storage cost, not
    a correctness issue).
    """
    record = await repo.get(exec_id, uid=None)
    if not record:
        return 0
    artifacts = record.get("artifacts") or []
    if artifacts and minio_enabled():
        client = get_minio_client()
        for art in artifacts:
            key = art.get("minio_key")
            if not key:
                continue
            try:
                await client.delete_object(key)
            except Exception as exc:
                logger.warning(
                    "[CODE_EXEC] minio delete failed key={} err={}", key, exc
                )
    return await repo.delete(exec_id)
