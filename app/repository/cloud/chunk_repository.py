"""
CloudUploadChunk CRUD repository — per-chunk tracking for resumable uploads.
"""

from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import select, func, update as sa_update, delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models import CloudUploadChunk


class CloudChunkRepository:
    """Persistence for cloud_upload_chunks (resumable-upload chunk tracking)."""

    # ------------------------------------------------------------------
    # batch_create
    # ------------------------------------------------------------------

    async def batch_create(
        self,
        upload_uuid: str,
        chunk_count: int,
        chunk_size: int,
        minio_upload_id: str,
        db: AsyncSession,
    ) -> int:
        """Create *chunk_count* chunk rows.  Returns number of rows created."""
        now = datetime.utcnow()
        chunks = [
            CloudUploadChunk(
                upload_uuid=upload_uuid,
                chunk_index=i,
                chunk_size=chunk_size,
                minio_upload_id=minio_upload_id,
                upload_status="pending",
                last_heartbeat=now,
            )
            for i in range(chunk_count)
        ]
        db.add_all(chunks)
        await db.commit()
        logger.info(
            f"[CLOUD_CHUNK_REPO] batch_created upload_uuid={upload_uuid} "
            f"count={chunk_count} chunk_size={chunk_size}"
        )
        return len(chunks)

    # ------------------------------------------------------------------
    # update_done
    # ------------------------------------------------------------------

    async def update_done(
        self,
        upload_uuid: str,
        chunk_index: int,
        etag: str,
        db: AsyncSession,
    ) -> None:
        """Mark a single chunk as completed with its ETag."""
        await db.execute(
            sa_update(CloudUploadChunk)
            .where(
                CloudUploadChunk.upload_uuid == upload_uuid,
                CloudUploadChunk.chunk_index == chunk_index,
            )
            .values(
                upload_status="completed",
                etag=etag,
                last_heartbeat=datetime.utcnow(),
                updated_at=datetime.utcnow(),
            )
        )
        await db.commit()

    # ------------------------------------------------------------------
    # all_done
    # ------------------------------------------------------------------

    async def all_done(self, upload_uuid: str, db: AsyncSession) -> bool:
        """Return True when every chunk for *upload_uuid* is 'completed'."""
        result = await db.execute(
            select(func.count()).where(
                CloudUploadChunk.upload_uuid == upload_uuid,
                CloudUploadChunk.upload_status != "completed",
            )
        )
        pending = result.scalar() or 0
        return pending == 0

    # ------------------------------------------------------------------
    # get_pending_chunks
    # ------------------------------------------------------------------

    async def get_pending_chunks(
        self, upload_uuid: str, db: AsyncSession,
    ) -> list[dict]:
        """Return pending chunks as lightweight dicts."""
        result = await db.execute(
            select(CloudUploadChunk)
            .where(
                CloudUploadChunk.upload_uuid == upload_uuid,
                CloudUploadChunk.upload_status == "pending",
            )
            .order_by(CloudUploadChunk.chunk_index)
        )
        chunks = result.scalars().all()
        return [
            {
                "id": c.id,
                "upload_uuid": c.upload_uuid,
                "chunk_index": c.chunk_index,
                "chunk_size": c.chunk_size,
                "minio_upload_id": c.minio_upload_id,
                "upload_url": c.upload_url,
                "upload_status": c.upload_status,
                "retry_count": c.retry_count,
            }
            for c in chunks
        ]

    # ------------------------------------------------------------------
    # get_minio_upload_id
    # ------------------------------------------------------------------

    async def get_minio_upload_id(
        self, upload_uuid: str, db: AsyncSession,
    ) -> Optional[str]:
        """Return the MinIO upload ID stored on chunk rows (first non-null)."""
        result = await db.execute(
            select(CloudUploadChunk.minio_upload_id).where(
                CloudUploadChunk.upload_uuid == upload_uuid,
                CloudUploadChunk.minio_upload_id.isnot(None),
            ).limit(1)
        )
        row = result.first()
        return row[0] if row else None

    # ------------------------------------------------------------------
    # delete_by_upload
    # ------------------------------------------------------------------

    async def delete_by_upload(
        self, upload_uuid: str, db: AsyncSession,
    ) -> None:
        """Hard-delete every chunk row for *upload_uuid*."""
        await db.execute(
            sa_delete(CloudUploadChunk).where(
                CloudUploadChunk.upload_uuid == upload_uuid,
            )
        )
        await db.commit()
        logger.info(
            f"[CLOUD_CHUNK_REPO] deleted all chunks for upload_uuid={upload_uuid}"
        )

    # ------------------------------------------------------------------
    # cleanup_stale
    # ------------------------------------------------------------------

    async def cleanup_stale(
        self, hours: int, db: AsyncSession,
    ) -> list[str]:
        """Remove chunk rows whose last heartbeat is older than *hours*.

        Returns the list of affected upload_uuids (so callers can also
        abort the corresponding MinIO multipart uploads).
        """
        cutoff = datetime.utcnow() - timedelta(hours=hours)

        # Find affected upload_uuids before deletion
        result = await db.execute(
            select(CloudUploadChunk.upload_uuid)
            .where(
                CloudUploadChunk.last_heartbeat < cutoff,
                CloudUploadChunk.upload_status == "pending",
            )
            .distinct()
        )
        stale_uuids = [row[0] for row in result.all()]

        if stale_uuids:
            await db.execute(
                sa_delete(CloudUploadChunk).where(
                    CloudUploadChunk.upload_uuid.in_(stale_uuids)
                )
            )
            await db.commit()
            logger.info(
                f"[CLOUD_CHUNK_REPO] cleanup_stale removed chunks for "
                f"{len(stale_uuids)} upload(s) older than {hours}h"
            )

        return stale_uuids


# Module-level singleton
_repo: Optional[CloudChunkRepository] = None


def get_cloud_chunk_repository() -> CloudChunkRepository:
    global _repo
    if _repo is None:
        _repo = CloudChunkRepository()
    return _repo
