"""Cloud storage cleanup — MinIO / MongoDB / Milvus deletion orchestration.

Absorbs the ``_cleanup_storage`` closure from ``delete_video`` and the
subtree-collection + MinIO batch deletion from ``delete_folder`` in
``app/routers/cloud.py``.

Failure isolation: each storage system is best-effort. A MinIO failure
does not block MongoDB / Milvus cleanup, and none of them block the
MySQL soft-delete (which is the source of truth and already committed
before this service is invoked).
"""
from __future__ import annotations

import asyncio
from typing import Optional

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.infra.config import config
from app.models import CloudFile, CloudFolder


# Strong refs so asyncio doesn't GC fire-and-forget cleanup tasks.
_background_tasks: set[asyncio.Task] = set()


def _spawn(coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


class CloudStorageCleanupService:
    """Delete cloud file/folder data from MinIO / Mongo / Milvus."""

    # ── delete_video ───────────────────────────────────────────────

    def spawn_video_cleanup(
        self, upload_uuid: str, object_key: Optional[str]
    ) -> None:
        """Fire-and-forget cleanup of a single video's storage."""
        _spawn(self._cleanup_video_storage(upload_uuid, object_key))

    async def _cleanup_video_storage(
        self,
        upload_uuid: str,
        object_key: Optional[str],
    ) -> None:
        if config.minio.enabled and object_key:
            try:
                from app.infra.minio import get_minio_client

                await get_minio_client().delete_object(object_key)
                logger.info(
                    "[CLOUD] minio object deleted upload_uuid={} object_key={}",
                    upload_uuid,
                    object_key,
                )
            except Exception as exc:
                logger.warning(
                    "[CLOUD] minio delete_object failed (orphaned) "
                    "upload_uuid={} object_key={} err={}",
                    upload_uuid,
                    object_key,
                    exc,
                )

        if config.mongo.enabled:
            try:
                from app.infra.mongo import is_enabled as mongo_ok, coll

                if mongo_ok():
                    result = await coll("asr_documents").delete_many(
                        {"bvid": upload_uuid}
                    )
                    logger.info(
                        "[CLOUD] mongo asr_documents deleted upload_uuid={} count={}",
                        upload_uuid,
                        result.deleted_count,
                    )
            except Exception as exc:
                logger.warning(
                    "[CLOUD] mongo cleanup failed upload_uuid={} err={}",
                    upload_uuid,
                    exc,
                )

        if config.milvus.enabled:
            try:
                from app.services.rag import get_rag_service

                rag = get_rag_service()
                rag.delete_cloud_vectors(upload_uuid)
            except Exception as exc:
                logger.warning(
                    "[CLOUD] milvus cleanup failed upload_uuid={} err={}",
                    upload_uuid,
                    exc,
                )

    # ── delete_folder ──────────────────────────────────────────────

    async def collect_folder_subtree(
        self,
        folder_id: int,
        uid: int,
        db: AsyncSession,
        force: bool,
    ) -> list[int]:
        """Collect folder IDs in the subtree rooted at ``folder_id``.

        Without ``force``, returns just ``[folder_id]``. With ``force``,
        BFS-collects all descendant folder IDs.
        """
        folder_ids = [folder_id]
        if not force:
            return folder_ids

        alive = CloudFolder.deleted_at.is_(None)
        queue = [folder_id]
        while queue:
            parent = queue.pop(0)
            child_result = await db.execute(
                select(CloudFolder.id).where(
                    CloudFolder.parent_id == parent,
                    CloudFolder.uid == uid,
                    alive,
                )
            )
            for (cid,) in child_result.all():
                folder_ids.append(cid)
                queue.append(cid)
        return folder_ids

    async def collect_folder_object_keys(
        self,
        folder_ids: list[int],
        uid: int,
        db: AsyncSession,
    ) -> list[str]:
        """Collect object_keys from all alive files in the given folders."""
        result = await db.execute(
            select(CloudFile.object_key).where(
                CloudFile.folder_id.in_(folder_ids),
                CloudFile.uid == uid,
                CloudFile.deleted_at.is_(None),
            )
        )
        return [row[0] for row in result.all()]

    async def delete_minio_objects(self, object_keys: list[str]) -> None:
        """Best-effort batch deletion of MinIO objects."""
        if not config.minio.enabled or not object_keys:
            return
        from app.infra.minio import get_minio_client

        minio_cli = get_minio_client()
        for ok in object_keys:
            try:
                await minio_cli.delete_object(ok)
            except Exception as exc:
                logger.warning(
                    "[CLOUD] delete_folder minio cleanup failed "
                    "object_key={} err={}",
                    ok,
                    exc,
                )


# ── Module-level singleton ────────────────────────────────────────

_service: Optional[CloudStorageCleanupService] = None


def get_cloud_storage_cleanup_service() -> CloudStorageCleanupService:
    global _service
    if _service is None:
        _service = CloudStorageCleanupService()
    return _service
