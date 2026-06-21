"""Cloud document processing service — ASR + vectorization pipeline.

Absorbs the ``trigger_processing`` and ``reprocess_document`` logic (and
their background tasks ``_run_pipeline`` / ``_run_doc_reprocess``) from
``app/routers/cloud.py``.

This module owns:
- mutating CloudFile status fields (asr_status / vector_status / vectorizable)
- spawning fire-and-forget background tasks (with strong refs)
- WS broadcast of status changes

It does NOT own: HTTP request parsing, response marshalling — those stay
in the router.
"""
from __future__ import annotations

import asyncio
import uuid as _uuid
from typing import Optional

from fastapi import HTTPException
from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.infra.config import config
from app.models import CloudFile
from app.repository.cloud.file_repository import get_cloud_file_repository
from app.services.async_task.tracker import TaskTracker


# Strong refs for fire-and-forget background tasks. Without this, asyncio
# may garbage-collect the task object mid-flight and the pipeline silently
# disappears (see CPython docs on asyncio.create_task).
_background_tasks: set[asyncio.Task] = set()


def _spawn(coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


class CloudProcessingService:
    """Trigger and orchestrate the cloud document processing pipeline."""

    async def trigger_processing(
        self,
        upload_uuid: str,
        uid: int,
        db: AsyncSession,
    ) -> CloudFile:
        """Mark file as processing and spawn the vectorization pipeline.

        Returns the CloudFile (post-mutation). Caller must handle 404 if
        the file does not exist.
        """
        file_repo = get_cloud_file_repository()
        file: Optional[CloudFile] = await file_repo.get_by_uuid(upload_uuid, uid, db)
        if file is None:
            raise HTTPException(status_code=404, detail="File not found")

        # Enforce mime allowlist on manual reprocess.
        from app.services.doc_parser import is_vectorizable

        if not is_vectorizable(file.mime_type, file.original_name):
            raise HTTPException(
                status_code=400,
                detail=f"This mime type is not supported: {file.mime_type}",
            )
        if not file.vectorizable:
            file.vectorizable = True

        # Mark processing immediately (visible in status + WS push)
        file.asr_status = "processing"
        file.vector_status = "processing"
        await db.commit()

        from app.services.ws_registry import broadcast_cloud_status

        _spawn(broadcast_cloud_status(uid, upload_uuid, "processing", 0))

        # Capture primitives before spawning (the request-scoped session + ORM
        # object are invalid after the response returns).
        _upload_uuid: str = upload_uuid
        _uid: int = uid
        _mime_type: str = file.mime_type

        _spawn(self._run_pipeline(_upload_uuid, _uid, _mime_type))
        return file

    async def reprocess_document(
        self,
        upload_uuid: str,
        uid: int,
        db: AsyncSession,
    ) -> str:
        """Reset state + re-vectorize a cloud document. Returns task_id.

        Raises 404 if file missing, 400 if not vectorizable.
        """
        file_repo = get_cloud_file_repository()
        file = await file_repo.get_by_uuid(upload_uuid, uid, db)
        if file is None:
            raise HTTPException(status_code=404, detail="File not found")
        if not file.vectorizable:
            raise HTTPException(
                status_code=400, detail="This file type is not vectorizable"
            )

        if config.milvus.enabled:
            try:
                from app.services.rag import get_rag_service

                rag = get_rag_service()
                rag.delete_cloud_vectors(upload_uuid)
            except Exception as e:
                logger.warning(
                    f"[CLOUD] reprocess: delete old vectors failed: {e}"
                )

        file.vector_status = "pending"
        file.vector_chunk_count = 0
        file.content_hash = None
        await db.commit()

        task_id = str(_uuid.uuid4())
        tracker = TaskTracker()
        await tracker.start(task_id, task_type="cloud_doc")

        _spawn(self._run_doc_reprocess(task_id, upload_uuid, uid))
        return task_id

    # ── Background tasks ───────────────────────────────────────────

    async def _run_pipeline(
        self,
        upload_uuid: str,
        uid: int,
        mime_type: str,
    ) -> None:
        """Fire-and-forget: parse → chunk → embed → verify → mark done."""
        from app.database import async_session_factory

        async with async_session_factory() as bg_db:
            try:
                logger.info(
                    f"[CLOUD] pipeline started upload_uuid={upload_uuid} "
                    f"uid={uid} type={mime_type}",
                )
                from app.services.doc_parser.vectorize import (
                    vectorize_cloud_document,
                )

                chunk_count = await vectorize_cloud_document(upload_uuid, uid, bg_db)
                logger.info(
                    f"[CLOUD] pipeline done upload_uuid={upload_uuid} "
                    f"chunks={chunk_count}",
                )
            except Exception:
                logger.exception(
                    f"[CLOUD] pipeline failed upload_uuid={upload_uuid}",
                )
                try:
                    file_repo = get_cloud_file_repository()
                    file = await file_repo.get_by_uuid(upload_uuid, uid, bg_db)
                    if file is not None and file.vector_status != "failed":
                        file.vector_status = "failed"
                        await bg_db.commit()
                except Exception:
                    logger.exception(
                        f"[CLOUD] failed to mark vector_status=failed for {upload_uuid}",
                    )

    async def _run_doc_reprocess(
        self,
        task_id: str,
        upload_uuid: str,
        uid: int,
    ) -> None:
        """Background task: re-parse + re-vectorize a cloud document."""
        from app.database import async_session_factory

        tracker = TaskTracker()
        try:
            async with async_session_factory() as bg_db:
                await tracker.step(task_id, "parse", "processing", 0)
                from app.services.doc_parser.vectorize import (
                    vectorize_cloud_document,
                )

                chunk_count = await vectorize_cloud_document(upload_uuid, uid, bg_db)
                await tracker.step(task_id, "parse", "done", 100)
                await tracker.complete(task_id, {"chunk_count": chunk_count})
        except Exception as e:
            logger.exception(
                "[CLOUD] _run_doc_reprocess failed task_id={}", task_id
            )
            await tracker.fail(task_id, str(e))


# ── Module-level singleton ────────────────────────────────────────

_service: Optional[CloudProcessingService] = None


def get_cloud_processing_service() -> CloudProcessingService:
    global _service
    if _service is None:
        _service = CloudProcessingService()
    return _service
