"""
Cloud upload orchestration — multipart upload lifecycle with resumable
chunks, heartbeat tracking, and ASR+vector pipeline trigger.
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
from app.infra.redis import client as redis_client, is_enabled as redis_enabled
from app.repository.cloud.file_repository import (
    get_cloud_file_repository,
    CloudFileRepository,
)
from app.repository.cloud.chunk_repository import (
    get_cloud_chunk_repository,
    CloudChunkRepository,
)
from app.repository.cloud.session_repository import (
    get_cloud_session_repository,
    CloudSessionRepository,
)
from app.services.cloud.minio_client import get_minio_client, MinioClient

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CHUNK_SIZE: int = 10 * 1024 * 1024       # 10 MB
MAX_FILE_SIZE: int = 5 * 1024 * 1024 * 1024  # 5 GB
HEARTBEAT_TTL: int = 300                  # 5 minutes in seconds

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
    """Return the current UUID7 epoch-adjusted timestamp in milliseconds.

    UUID7 uses the number of milliseconds since 2020-01-01T00:00:00Z
    (the UUID version 15 epoch), rolled over so that the 48-bit counter
    does not overflow until ~8907 CE.
    """
    global _UUID7_EPOCH_MS
    if _UUID7_EPOCH_MS == 0:
        # 2020-01-01T00:00:00.000Z in Unix milliseconds
        import datetime as _dt
        _UUID7_EPOCH_MS = int(
            _dt.datetime(2020, 1, 1, tzinfo=_dt.timezone.utc).timestamp() * 1000
        )
    now_ms = int(time.time() * 1000)
    return now_ms - _UUID7_EPOCH_MS


def _generate_uuid7() -> str:
    """Generate a time-ordered UUIDv7 string.

    Format: 48-bit Unix timestamp (ms) | 4-bit version (0x7) | 12-bit
    rand_a | 2-bit variant (10) | 62-bit rand_b.
    """
    ts = _uuid7_timestamp() & 0xFFFFFFFFFFFF  # 48 bits

    r = int.from_bytes(os.urandom(10), "big")

    # rand_a: upper 12 bits of r
    rand_a = (r >> 50) & 0xFFF
    # rand_b: lower 62 bits of r
    rand_b = r & 0x3FFFFFFFFFFFFFFF

    # Assemble fields
    time_low = ts & 0xFFFFFFFF
    time_mid = (ts >> 32) & 0xFFFF
    time_hi = ((ts >> 48) & 0xFFF) | 0x7000  # version 7
    clock_seq = (rand_a >> 2) | 0x8000        # variant 10xx
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

    Responsibilities
    ----------------
    - Validate inputs (file size, mime type)
    - Create MinIO multipart upload + presigned chunk URLs
    - Persist file / chunk / session rows via repositories
    - Track heartbeat in Redis for session liveness
    - Resume interrupted uploads
    - Fire-and-forget ASR + vector pipeline on completion
    """

    def __init__(
        self,
        minio_client: MinioClient | None = None,
        file_repo: CloudFileRepository | None = None,
        chunk_repo: CloudChunkRepository | None = None,
        session_repo: CloudSessionRepository | None = None,
    ) -> None:
        self._minio = minio_client or get_minio_client()
        self._file_repo = file_repo or get_cloud_file_repository()
        self._chunk_repo = chunk_repo or get_cloud_chunk_repository()
        self._session_repo = session_repo or get_cloud_session_repository()

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

        Returns a dict with *uploadUuid*, *sessionUuid*, *minioUploadId*,
        *chunkCount*, *chunkSize*, and *presignedUrls* (one per chunk).
        """
        # ---- validation ----
        if not any(mime_type.startswith(p) for p in ALLOWED_MIME_PREFIXES):
            raise ValueError(
                f"Unsupported mime_type={mime_type!r}"
            )
        if file_size <= 0:
            raise ValueError(f"file_size must be positive, got {file_size}")
        if file_size > MAX_FILE_SIZE:
            raise ValueError(
                f"File too large: {file_size} bytes (max {MAX_FILE_SIZE})"
            )

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
            logger.exception(
                "[CLOUD_UPLOAD] minio create_multipart_upload failed"
            )
            raise

        # ---- DB rows ----
        # 1. CloudFile
        await self._file_repo.create(
            upload_uuid=upload_uuid,
            uid=uid,
            original_name=filename,
            file_size=file_size,
            mime_type=mime_type,
            folder_id=folder_id,
            bucket=config.minio.bucket,
            object_key=object_key,
            db=db,
        )

        # 2. CloudUploadChunk batch
        await self._chunk_repo.batch_create(
            upload_uuid=upload_uuid,
            chunk_count=chunk_count,
            chunk_size=CHUNK_SIZE,
            minio_upload_id=minio_upload_id,
            db=db,
        )

        # 3. CloudUploadSession (one session groups this batch)
        await self._session_repo.create(
            session_uuid=session_uuid,
            uid=uid,
            minio_upload_id=minio_upload_id,
            total_files=1,
            db=db,
        )

        # ---- presigned URLs ----
        presigned_urls: list[dict] = []
        try:
            for part_number in range(1, chunk_count + 1):
                url = await self._minio.presigned_upload_part(
                    object_key, minio_upload_id, part_number,
                )
                presigned_urls.append({
                    "chunkIndex": part_number - 1,
                    "chunkSize": CHUNK_SIZE,
                    "url": url,
                })
        except Exception:
            logger.exception(
                "[CLOUD_UPLOAD] presigned_url generation failed, aborting"
            )
            await self._minio.abort_multipart_upload(object_key, minio_upload_id)
            await self._session_repo.mark_abandoned(session_uuid, db)
            raise

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

        *parts* must be a list of dicts with ``PartNumber`` (int) and
        ``ETag`` (str), sorted by part number.
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
            await self._file_repo.update_upload_failed(upload_uuid, db)
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
        """Write a heartbeat entry to Redis (SETEX, 300s TTL).

        Returns a status dict; graceful degradation when Redis is disabled.
        """
        await self._set_heartbeat(session_uuid)
        return {"sessionUuid": session_uuid, "status": "alive"}

    async def _set_heartbeat(self, session_uuid: str) -> None:
        """Internal: Redis SETEX heartbeat key."""
        if not redis_enabled() or redis_client is None:
            logger.debug(
                "[CLOUD_UPLOAD] heartbeat skipped — Redis disabled"
            )
            return
        try:
            key = f"{config.redis.key_prefix}cloud:heartbeat:{session_uuid}"
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

        Returns a dict with *uploadUuid*, *minioUploadId*, and
        *pendingChunks* (list of dicts with chunk_index, chunk_size,
        presigned_url).
        """
        file = await self._file_repo.get_by_uuid(upload_uuid, uid, db)
        if file is None:
            raise ValueError(
                f"CloudFile {upload_uuid} not found for user {uid}"
            )

        if file.upload_status == "completed":
            return {
                "uploadUuid": upload_uuid,
                "status": "already_completed",
                "pendingChunks": [],
            }

        minio_upload_id = await self._chunk_repo.get_minio_upload_id(
            upload_uuid, db
        )
        if not minio_upload_id:
            raise ValueError(
                f"Upload is not resumable — no minio_upload_id for {upload_uuid}"
            )

        pending = await self._chunk_repo.get_pending_chunks(upload_uuid, db)

        # Generate fresh presigned URLs for each pending chunk
        object_key = file.object_key
        pending_chunks: list[dict] = []
        try:
            for chunk in pending:
                url = await self._minio.presigned_upload_part(
                    object_key,
                    minio_upload_id,
                    chunk["chunk_index"] + 1,  # part_number is 1-indexed
                )
                pending_chunks.append({
                    "chunkIndex": chunk["chunk_index"],
                    "chunkSize": chunk["chunk_size"],
                    "presignedUrl": url,
                })
        except Exception:
            logger.exception(
                "[CLOUD_UPLOAD] resume presigned_url generation failed"
            )
            raise

        logger.info(
            "[CLOUD_UPLOAD] resume_upload upload_uuid=%s pending=%d",
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
        """Fire-and-forget ASR + vector pipeline.

        Called after a successful upload completion.  Failure here should
        never propagate to the upload response.
        """
        async def _run():
            try:
                logger.info(
                    "[CLOUD_UPLOAD] pipeline triggered upload_uuid=%s uid=%d",
                    upload_uuid, uid,
                )
                # TODO: wire up actual ASR + vectorisation when those
                # modules are cloud-aware.
                # For now the file is stored; ASR / vector status remain
                # "pending" and a background worker picks them up.
                #
                # from app.services.asr import asr_service
                # await asr_service.process_cloud_file(upload_uuid, uid)
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
