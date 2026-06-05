"""
Cloud upload orchestration — multipart upload lifecycle with resumable
chunks, heartbeat tracking, and ASR+vector pipeline trigger.

Upload metadata is stored in Redis during the upload window (1 h TTL).
CloudFile DB rows are only created on successful completion — if the
client abandons the upload, no permanent DB garbage is left behind.
"""

from __future__ import annotations

import asyncio
import math
import os
import time

from typing import Optional

from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.infra.config import config
from app.infra.redis import client as redis_client, is_enabled as redis_enabled, k, jset, jget
from app.repository.cloud.file_repository import (
    get_cloud_file_repository,
    CloudFileRepository,
)
from app.services.cloud.minio_client import get_minio_client, MinioClient

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CHUNK_SIZE: int = 10 * 1024 * 1024       # 10 MB
MAX_FILE_SIZE: int = 5 * 1024 * 1024 * 1024  # 5 GB
HEARTBEAT_TTL: int = 300                  # 5 minutes in seconds
UPLOAD_META_TTL: int = 3600               # 1 hour — upload window

_MIME_TO_EXT: dict[str, str] = {
    "video/": ".mp4",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/x-markdown": ".md",
    "text/csv": ".csv",
    "text/html": ".html",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/x-rar-compressed": ".rar",
    "application/x-7z-compressed": ".7z",
    "application/vnd.openxmlformats-officedocument.wordprocessingml": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml": ".xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml": ".pptx",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
}


def _ext_from_mime(mime_type: str) -> str:
    for prefix, ext in _MIME_TO_EXT.items():
        if mime_type.startswith(prefix):
            return ext
    return ".bin"


ALLOWED_MIME_PREFIXES: list[str] = [
    "video/",
    "text/plain",
    "text/markdown",
    "text/x-markdown",
    "text/csv",
    "text/html",
    "application/vnd.openxmlformats-officedocument.wordprocessingml",
    "application/vnd.openxmlformats-officedocument.spreadsheetml",
    "application/vnd.openxmlformats-officedocument.presentationml",
    "application/pdf",
    "application/zip",
    "application/x-rar-compressed",
    "application/x-7z-compressed",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/tiff",
]

# ---------------------------------------------------------------------------
# UUID7 generator (time-ordered)
# ---------------------------------------------------------------------------

_UUID7_EPOCH_MS: int = 0


def _uuid7_timestamp() -> int:
    """Return the current UUID7 epoch-adjusted timestamp in milliseconds."""
    global _UUID7_EPOCH_MS
    if _UUID7_EPOCH_MS == 0:
        import datetime as _dt
        _UUID7_EPOCH_MS = int(
            _dt.datetime(2020, 1, 1, tzinfo=_dt.timezone.utc).timestamp() * 1000
        )
    now_ms = int(time.time() * 1000)
    return now_ms - _UUID7_EPOCH_MS


def _generate_uuid7() -> str:
    """Generate a time-ordered UUIDv7 string."""
    ts = _uuid7_timestamp() & 0xFFFFFFFFFFFF  # 48 bits
    r = int.from_bytes(os.urandom(10), "big")
    rand_a = (r >> 50) & 0xFFF
    rand_b = r & 0x3FFFFFFFFFFFFFFF
    time_low = ts & 0xFFFFFFFF
    time_mid = (ts >> 32) & 0xFFFF
    time_hi = ((ts >> 48) & 0xFFF) | 0x7000
    clock_seq = (rand_a >> 2) | 0x8000
    clock_seq_low = rand_a & 0xFF
    node = rand_b
    return (
        f"{time_low:08x}-{time_mid:04x}-{time_hi:04x}-"
        f"{clock_seq:04x}-{clock_seq_low:02x}{node:012x}"
    )


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class CloudUploadService:
    """Orchestrate the full multipart-upload lifecycle.

    Redis stores in-progress upload metadata (key ``cloud:upload:{uuid}``,
    TTL 1 h).  The DB CloudFile row is only created on successful
    ``complete_upload`` — abandoned uploads expire from Redis and leave
    no permanent garbage.
    """

    def __init__(
        self,
        minio_client: MinioClient | None = None,
        file_repo: CloudFileRepository | None = None,
    ) -> None:
        self._minio = minio_client or get_minio_client()
        self._file_repo = file_repo or get_cloud_file_repository()

    # ------------------------------------------------------------------
    # Redis helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _upload_key(upload_uuid: str) -> str:
        return k("cloud", "upload", upload_uuid)

    async def _get_upload_meta(self, upload_uuid: str) -> dict:
        """Fetch upload metadata from Redis.  Raises ValueError on miss."""
        if not redis_enabled() or redis_client is None:
            raise ValueError("Redis is required for cloud uploads")
        meta = await jget(self._upload_key(upload_uuid))
        if meta is None:
            raise ValueError(f"Upload session expired or not found: {upload_uuid}")
        return meta

    async def _set_upload_meta(self, upload_uuid: str, meta: dict) -> None:
        if not redis_enabled() or redis_client is None:
            raise ValueError("Redis is required for cloud uploads")
        await jset(self._upload_key(upload_uuid), meta, ex=UPLOAD_META_TTL)

    async def _delete_upload_meta(self, upload_uuid: str) -> None:
        if redis_client is not None:
            await redis_client.delete(self._upload_key(upload_uuid))

    # ------------------------------------------------------------------
    # init_upload
    # ------------------------------------------------------------------

    async def init_upload(
        self,
        uid: int,
        filename: str,
        file_size: int,
        mime_type: str,
        folder_id: int | None,
        db: AsyncSession,
    ) -> dict:
        """Start a new multipart upload.

        Only creates the MinIO multipart upload + presigned URLs.
        The DB record is deferred until :meth:`complete_upload`.
        """
        # ---- validation ----
        if not any(mime_type.startswith(p) for p in ALLOWED_MIME_PREFIXES):
            raise ValueError(
                f"Unsupported mime_type={mime_type!r}"
            )
        if file_size <= 0:
            raise ValueError(f"file_size must be positive, got {file_size}")
        if file_size > MAX_FILE_SIZE:
            raise ValueError(f"File too large: {file_size} bytes (max {MAX_FILE_SIZE})")

        upload_uuid = _generate_uuid7()
        session_uuid = _generate_uuid7()
        object_key = f"{uid}/{upload_uuid}/file{_ext_from_mime(mime_type)}"
        chunk_count = math.ceil(file_size / CHUNK_SIZE)

        logger.info(
            "[CLOUD_UPLOAD] init_upload uid=%d filename=%s size=%d "
            "chunks=%d upload_uuid=%s",
            uid, filename, file_size, chunk_count, upload_uuid,
        )

        # ---- MinIO multipart upload ----
        try:
            minio_upload_id = await self._minio.create_multipart_upload(object_key)
        except Exception:
            logger.exception("[CLOUD_UPLOAD] minio create_multipart_upload failed")
            raise

        # ---- presigned URLs ----
        presigned_urls: list[str] = []
        try:
            for part_number in range(1, chunk_count + 1):
                url = await self._minio.presigned_upload_part(
                    object_key, minio_upload_id, part_number,
                )
                presigned_urls.append(url)
        except Exception:
            logger.exception(
                "[CLOUD_UPLOAD] presigned_url generation failed, aborting"
            )
            await self._minio.abort_multipart_upload(object_key, minio_upload_id)
            raise

        # ---- store metadata in Redis (DB record deferred) ----
        meta = {
            "uid": uid,
            "original_name": filename,
            "file_size": file_size,
            "mime_type": mime_type,
            "folder_id": folder_id,
            "bucket": config.minio.bucket,
            "object_key": object_key,
            "minio_upload_id": minio_upload_id,
            "chunk_count": chunk_count,
            "chunk_size": CHUNK_SIZE,
            "session_uuid": session_uuid,
        }
        await self._set_upload_meta(upload_uuid, meta)

        # ---- heartbeat ----
        await self._set_heartbeat(session_uuid)

        logger.info(
            "[CLOUD_UPLOAD] init_upload complete upload_uuid=%s session_uuid=%s",
            upload_uuid, session_uuid,
        )

        return {
            "uploadUuid": upload_uuid,
            "sessionUuid": session_uuid,
            "minioUploadId": minio_upload_id,
            "chunkCount": chunk_count,
            "chunkSize": CHUNK_SIZE,
            "presignedUrls": presigned_urls,
        }

    # ------------------------------------------------------------------
    # complete_upload
    # ------------------------------------------------------------------

    async def complete_upload(
        self,
        upload_uuid: str,
        parts: list[dict],
        uid: int,
        db: AsyncSession,
    ) -> dict:
        """Finalise a multipart upload.

        Creates the CloudFile DB row only after MinIO confirms the
        multipart upload — no permanent DB record exists until this
        method succeeds.
        """
        # ---- validate ownership ----
        file = await self._file_repo.get_by_uuid(upload_uuid, uid, db)
        if file is None:
            raise ValueError(
                f"CloudFile {upload_uuid} not found for user {uid}"
            )

        # ---- guard: only proceed if still uploading ----
        if file.upload_status != "uploading":
            raise ValueError(
                f"Upload {upload_uuid} is already {file.upload_status}, "
                f"cannot complete"
            )

        # ---- get minio_upload_id ----
        minio_upload_id = await self._chunk_repo.get_minio_upload_id(
            upload_uuid, db
        )
        if not minio_upload_id:
            raise ValueError(
                f"No minio_upload_id found for upload_uuid={upload_uuid}"
            )

        # ---- complete MinIO multipart ----
        object_key = file.object_key
        try:
            etag = await self._minio.complete_multipart_upload(
                object_key, minio_upload_id, parts,
            )
        except Exception:
            logger.exception(
                "[CLOUD_UPLOAD] minio complete_multipart_upload failed"
            )
            raise

        # ---- mark DB completed ----
        try:
            await self._file_repo.update_upload_completed(upload_uuid, etag, db)
        except Exception:
            logger.critical(
                "[CLOUD_UPLOAD] DB update failed after MinIO complete "
                "upload_uuid=%s etag=%s — manual fix required!",
                upload_uuid, etag,
            )
            raise

        # ---- clean up chunk rows ----
        await self._chunk_repo.delete_by_upload(upload_uuid, db)

        # ---- update session (lookup by minio_upload_id) ----
        try:
            await self._session_repo.mark_completed_by_minio_upload_id(
                minio_upload_id, db,
            )
        except Exception:
            logger.debug(
                "[CLOUD_UPLOAD] session mark_completed skipped "
                "upload_uuid=%s minio_upload_id=%s",
                upload_uuid, minio_upload_id,
            )

        logger.info(
            "[CLOUD_UPLOAD] complete_upload done upload_uuid=%s etag=%s",
            upload_uuid, etag,
        )

        # ---- fire-and-forget pipeline ----
        await self._trigger_pipeline(upload_uuid, uid)

        return {
            "uploadUuid": upload_uuid,
            "etag": etag,
            "status": "completed",
        }

    # ------------------------------------------------------------------
    # heartbeat
    # ------------------------------------------------------------------

    async def heartbeat(self, session_uuid: str) -> dict:
        """Write a heartbeat entry to Redis (SETEX, 300s TTL)."""
        await self._set_heartbeat(session_uuid)
        return {"sessionUuid": session_uuid, "status": "alive"}

    async def _set_heartbeat(self, session_uuid: str) -> None:
        """Internal: Redis SETEX heartbeat key."""
        if not redis_enabled() or redis_client is None:
            logger.debug("[CLOUD_UPLOAD] heartbeat skipped — Redis disabled")
            return
        try:
            key = k("cloud", "heartbeat", session_uuid)
            await redis_client.setex(key, HEARTBEAT_TTL, "alive")
            logger.debug(
                "[CLOUD_UPLOAD] heartbeat set session_uuid=%s ttl=%d",
                session_uuid, HEARTBEAT_TTL,
            )
        except Exception:
            logger.warning(
                "[CLOUD_UPLOAD] heartbeat Redis SETEX failed session_uuid=%s",
                session_uuid,
            )

    # ------------------------------------------------------------------
    # resume_upload
    # ------------------------------------------------------------------

    async def resume_upload(
        self,
        upload_uuid: str,
        uid: int,
        db: AsyncSession,
    ) -> dict:
        """Resume an interrupted upload.

        Reads metadata from Redis and generates fresh presigned URLs
        for all chunks.
        """
        meta = await self._get_upload_meta(upload_uuid)
        if meta["uid"] != uid:
            raise ValueError(f"Upload {upload_uuid} does not belong to user {uid}")

        object_key = meta["object_key"]
        minio_upload_id = meta["minio_upload_id"]
        chunk_count = meta["chunk_count"]

        # Generate fresh presigned URLs for every chunk
        pending_chunks: list[dict] = []
        try:
            for part_number in range(1, chunk_count + 1):
                url = await self._minio.presigned_upload_part(
                    object_key, minio_upload_id, part_number,
                )
                pending_chunks.append({
                    "chunkIndex": part_number - 1,
                    "chunkSize": meta["chunk_size"],
                    "presignedUrl": url,
                })
        except Exception:
            logger.exception(
                "[CLOUD_UPLOAD] resume presigned_url generation failed"
            )
            raise

        logger.info(
            "[CLOUD_UPLOAD] resume_upload upload_uuid=%s chunks=%d",
            upload_uuid, len(pending_chunks),
        )

        return {
            "uploadUuid": upload_uuid,
            "minioUploadId": minio_upload_id,
            "status": "resuming",
            "pendingChunks": pending_chunks,
        }

    # ------------------------------------------------------------------
    # pipeline trigger
    # ------------------------------------------------------------------

    async def _trigger_pipeline(self, upload_uuid: str, uid: int) -> None:
        """Fire-and-forget ASR + vector pipeline."""

        async def _run():
            try:
                logger.info(
                    "[CLOUD_UPLOAD] pipeline triggered upload_uuid=%s uid=%d",
                    upload_uuid, uid,
                )
                # TODO: wire up actual ASR + vectorisation
            except Exception:
                logger.exception(
                    "[CLOUD_UPLOAD] pipeline failed upload_uuid=%s",
                    upload_uuid,
                )

        asyncio.create_task(_run())


# ---------------------------------------------------------------------------
# module-level singleton
# ---------------------------------------------------------------------------

_service: Optional[CloudUploadService] = None


def get_cloud_upload_service() -> CloudUploadService:
    global _service
    if _service is None:
        _service = CloudUploadService()
    return _service
