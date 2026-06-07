"""
Cloud-upload resource cleanup — Redis keyspace listener and startup
reconciliation to prevent orphaned MinIO multipart uploads and stale
MySQL rows.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db_context
from app.infra.config import config
from app.infra.redis import (
    client as redis_client,
    is_enabled as redis_enabled,
    pubsub,
)
from app.models import CloudFile, CloudUploadChunk, CloudUploadSession
from app.repository.cloud.chunk_repository import get_cloud_chunk_repository
from app.repository.cloud.session_repository import get_cloud_session_repository
from app.infra.minio import get_minio_client

# ---------------------------------------------------------------------------
# Keyspace listener
# ---------------------------------------------------------------------------

_HEARTBEAT_PREFIX: str = f"{config.redis.key_prefix}cloud:heartbeat:"


def _extract_session_uuid(key: str) -> Optional[str]:
    """Extract session_uuid from a heartbeat key, or None if not a match."""
    if key.startswith(_HEARTBEAT_PREFIX) and len(key) > len(_HEARTBEAT_PREFIX):
        return key[len(_HEARTBEAT_PREFIX):]
    return None


async def start_keyspace_listener() -> None:
    """Subscribe to Redis keyspace-expiry notifications.

    When a ``cloud:heartbeat:*`` key expires (TTL elapsed with no
    heartbeat), the corresponding upload session is cleaned up.

    This function runs forever and should be launched as a background task
    during application startup.
    """
    if not redis_enabled():
        logger.info("[CLOUD_CLEANUP] keyspace listener skipped -- Redis disabled")
        return

    logger.info("[CLOUD_CLEANUP] starting keyspace listener")
    try:
        ps = pubsub()
        # Redis must be configured with: notify-keyspace-events Ex
        await ps.subscribe("__keyevent@0__:expired")

        async for message in ps.listen():
            if message is None:
                continue
            if message.get("type") != "message":
                continue

            key = message.get("data", "")
            if isinstance(key, bytes):
                key = key.decode("utf-8", errors="replace")

            session_uuid = _extract_session_uuid(key)
            if session_uuid is None:
                continue

            logger.info(
                "[CLOUD_CLEANUP] heartbeat expired session_uuid=%s",
                session_uuid,
            )
            await _cleanup_session(session_uuid)

    except asyncio.CancelledError:
        logger.info("[CLOUD_CLEANUP] keyspace listener cancelled")
    except Exception:
        logger.exception("[CLOUD_CLEANUP] keyspace listener crashed")


# ---------------------------------------------------------------------------
# Startup reconciliation
# ---------------------------------------------------------------------------


async def reconcile_on_startup() -> None:
    """Scan all active upload sessions and clean up those with stale heartbeats.

    Called once during application startup.  Sessions whose heartbeat key is
    absent from Redis (or Redis is unavailable) are treated as abandoned.
    """
    logger.info("[CLOUD_CLEANUP] startup reconciliation begin")

    try:
        async with get_db_context() as db:
            session_repo = get_cloud_session_repository()
            active_sessions = await session_repo.get_active_sessions(db)

            if not active_sessions:
                logger.info("[CLOUD_CLEANUP] no active sessions to reconcile")
                return

            logger.info(
                "[CLOUD_CLEANUP] reconciling %d active session(s)",
                len(active_sessions),
            )

            for session in active_sessions:
                if not await _is_heartbeat_alive(session.session_uuid):
                    logger.info(
                        "[CLOUD_CLEANUP] stale session session_uuid=%s",
                        session.session_uuid,
                    )
                    await _cleanup_session(session.session_uuid)

    except Exception:
        logger.exception("[CLOUD_CLEANUP] startup reconciliation failed")

    logger.info("[CLOUD_CLEANUP] startup reconciliation done")


async def _is_heartbeat_alive(session_uuid: str) -> bool:
    """Check whether a heartbeat key exists in Redis for *session_uuid*.

    Returns True if Redis is disabled (cannot check -- assume alive so we
    do not accidentally clean up active sessions).
    """
    if not redis_enabled() or redis_client is None:
        return True  # cannot verify; err on the side of caution

    try:
        key = f"{_HEARTBEAT_PREFIX}{session_uuid}"
        exists = await redis_client.exists(key)
        return bool(exists)
    except Exception:
        logger.warning(
            "[CLOUD_CLEANUP] Redis exists check failed session_uuid=%s",
            session_uuid,
        )
        return True  # assume alive on Redis failure


# ---------------------------------------------------------------------------
# Session cleanup
# ---------------------------------------------------------------------------


async def _cleanup_session(session_uuid: str) -> None:
    """Clean up all resources tied to an abandoned upload session.

    1. Abort each associated MinIO multipart upload (free server-side storage).
    2. Mark MySQL ``cloud_upload_sessions`` row as 'abandoned'.
    3. Mark MySQL ``cloud_files`` rows as failed.
    4. Hard-delete ``cloud_upload_chunks`` rows.
    """
    logger.info("[CLOUD_CLEANUP] cleaning session_uuid=%s", session_uuid)

    try:
        async with get_db_context() as db:
            # Resolve the session row to get its minio_upload_id
            session_row = await _get_session_by_uuid(session_uuid, db)

            if session_row is not None:
                # Find all upload_uuids that share this session's minio_upload_id
                minio_uid = session_row.minio_upload_id
                if minio_uid:
                    await _abort_minio_for_uploads(minio_uid, db)

            # Mark session abandoned
            await get_cloud_session_repository().mark_abandoned(session_uuid, db)

            # Hard-delete chunks tied to the session's minio_upload_id
            if session_row is not None and session_row.minio_upload_id:
                from sqlalchemy import delete as sa_delete
                await db.execute(
                    sa_delete(CloudUploadChunk).where(
                        CloudUploadChunk.minio_upload_id
                        == session_row.minio_upload_id,
                    )
                )
                await db.commit()

        logger.info("[CLOUD_CLEANUP] cleanup done session_uuid=%s", session_uuid)

    except Exception:
        logger.exception(
            "[CLOUD_CLEANUP] cleanup failed session_uuid=%s", session_uuid,
        )


async def _get_session_by_uuid(
    session_uuid: str, db: AsyncSession,
) -> Optional[CloudUploadSession]:
    """Low-level lookup for a session row (no uid filter, cleanup use only)."""
    result = await db.execute(
        select(CloudUploadSession).where(
            CloudUploadSession.session_uuid == session_uuid,
        )
    )
    return result.scalar_one_or_none()


async def _abort_minio_for_uploads(
    minio_upload_id: str, db: AsyncSession,
) -> None:
    """Abort every MinIO multipart upload that matches *minio_upload_id*.

    Walks CloudFile rows whose upload_uuid matches the chunk rows for
    the given minio_upload_id.
    """
    minio_client = get_minio_client()
    if not minio_client.enabled:
        return

    # Find distinct upload_uuids for this minio_upload_id
    result = await db.execute(
        select(CloudUploadChunk.upload_uuid)
        .where(CloudUploadChunk.minio_upload_id == minio_upload_id)
        .distinct()
    )
    upload_uuids = [row[0] for row in result.all()]

    for upload_uuid in upload_uuids:
        # Get object_key from CloudFile
        file_result = await db.execute(
            select(CloudFile.object_key).where(
                CloudFile.upload_uuid == upload_uuid,
            )
        )
        file_row = file_result.first()
        if file_row is None:
            continue

        object_key = file_row[0]
        try:
            await minio_client.abort_multipart_upload(object_key, minio_upload_id)
        except Exception:
            logger.warning(
                "[CLOUD_CLEANUP] minio_abort failed upload_uuid=%s", upload_uuid,
            )


# ---------------------------------------------------------------------------
# Scheduled dead-chunk cleanup
# ---------------------------------------------------------------------------


async def cleanup_dead_chunks(max_age_hours: int = 24) -> int:
    """Hard-delete chunk rows with no heartbeat for *max_age_hours*.

    Also attempts to abort the corresponding MinIO multipart uploads.

    Returns the number of affected upload_uuids.
    """
    logger.info(
        "[CLOUD_CLEANUP] dead chunk cleanup max_age_hours=%d", max_age_hours,
    )

    try:
        async with get_db_context() as db:
            chunk_repo = get_cloud_chunk_repository()
            stale_uuids = await chunk_repo.cleanup_stale(max_age_hours, db)

            if not stale_uuids:
                logger.info("[CLOUD_CLEANUP] no dead chunks found")
                return 0

            logger.info(
                "[CLOUD_CLEANUP] found %d stale upload(s)", len(stale_uuids),
            )

            # Best-effort: abort MinIO multipart uploads for stale uploads
            minio_client = get_minio_client()
            if minio_client.enabled:
                for upload_uuid in stale_uuids:
                    await _abort_minio_for_stale_upload(upload_uuid, db)

            # Mark the corresponding CloudFile rows as failed
            from sqlalchemy import update as sa_update
            from datetime import datetime, timezone

            await db.execute(
                sa_update(CloudFile)
                .where(CloudFile.upload_uuid.in_(stale_uuids))
                .values(
                    upload_status="failed",
                    updated_at=datetime.now(timezone.utc),
                )
            )
            await db.commit()

        return len(stale_uuids)

    except Exception:
        logger.exception("[CLOUD_CLEANUP] dead chunk cleanup failed")
        return 0


async def _abort_minio_for_stale_upload(
    upload_uuid: str, db: AsyncSession,
) -> None:
    """Try to abort the MinIO multipart upload for a stale upload_uuid."""
    minio_client = get_minio_client()

    # Get object_key
    result = await db.execute(
        select(CloudFile.object_key).where(
            CloudFile.upload_uuid == upload_uuid,
        )
    )
    row = result.first()
    if row is None:
        return

    object_key = row[0]

    # Get minio_upload_id from any remaining chunk row (they may
    # already be deleted; catch the error gracefully)
    try:
        chunk_result = await db.execute(
            select(CloudUploadChunk.minio_upload_id).where(
                CloudUploadChunk.upload_uuid == upload_uuid,
                CloudUploadChunk.minio_upload_id.isnot(None),
            ).limit(1)
        )
        chunk_row = chunk_result.first()
        if chunk_row and chunk_row[0]:
            await minio_client.abort_multipart_upload(object_key, chunk_row[0])
    except Exception:
        logger.debug(
            "[CLOUD_CLEANUP] minio abort skipped for stale upload_uuid=%s",
            upload_uuid,
        )
