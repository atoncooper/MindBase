"""
Per-page vectorization service — atomic protection + step-level progress.
"""

import asyncio
import uuid
from datetime import datetime
from typing import Optional

from loguru import logger
from sqlalchemy import select

from app.database import get_db_context
from app.models import Video
from app.response.knowledge import VideoContent, ContentSource
from app.services.async_task.tracker import TaskTracker


class VectorPageService:
    """Per-page vectorization with atomic state management."""

    def __init__(self, tracker: TaskTracker, rag=None):
        self.tracker = tracker
        self._rag = rag

    @property
    def rag(self):
        if self._rag is None:
            from app.services.rag import get_rag_service
            self._rag = get_rag_service()
        return self._rag

    async def process_page_vectorization(
        self,
        task_id: str,
        bvid: str,
        cid: int,
        page_index: int,
        page_title: Optional[str] = None,
    ):
        """Run the full vectorization pipeline for a single page."""
        try:
            await self.tracker.start(task_id)
            await self.tracker.step(task_id, name="init", status="processing", progress=0)

            # === Phase 1: guard + idempotency check ===
            async with get_db_context() as db:
                result = await db.execute(
                    select(Video).where(Video.bvid == bvid, Video.cid == cid)
                )
                page = result.scalar_one_or_none()
                if not page:
                    raise Exception(f"Video not found: bvid={bvid}, cid={cid}")

                if page.is_vectorized == "done" and not self._content_changed(page):
                    await self.tracker.complete(task_id, result={"skipped": True, "message": "Already up to date"})
                    return

                page.is_vectorized = "pending"
                page.vector_error = None
                await db.commit()

            await self.tracker.set_progress(task_id, 10)
            await self.tracker.step(task_id, name="init", status="done", progress=100)

            # === Phase 2: ASR (if needed) ===
            if not page.is_processed:
                await self.tracker.step(task_id, name="asr", status="processing", progress=0)
                await self._run_asr(bvid, cid, page_index,
                                    page_title or page.page_title or f"P{page_index + 1}")
                await self.tracker.step(task_id, name="asr", status="done", progress=100)

            # === Phase 3: delete old vectors ===
            await self.tracker.set_progress(task_id, 40)
            await self.tracker.step(task_id, name="vec", status="processing", progress=30)
            try:
                self._delete_page_vectors(bvid, page_index)
            except Exception as e:
                logger.warning(f"[{bvid}] failed to delete old vectors: {e}")

            # === Phase 4: insert new vectors ===
            await self.tracker.set_progress(task_id, 60)

            async with get_db_context() as db:
                result = await db.execute(
                    select(Video).where(Video.bvid == bvid, Video.cid == cid)
                )
                page = result.scalar_one_or_none()
                if not page:
                    raise Exception(f"Video not found: bvid={bvid}, cid={cid}")

                text = ""
                from app.infra.mongo import is_enabled as _mongo_ok
                from app.repository.mongo_asr_repository import get_latest

                if _mongo_ok():
                    doc = await get_latest(bvid, cid)
                    if doc:
                        text = doc.get("content", "")

                if not text:
                    logger.warning(f"[{bvid}] no content in MongoDB, triggering ASR")
                    await self._run_asr(bvid, cid, page_index,
                                        page_title or page.page_title or f"P{page_index + 1}")
                    if _mongo_ok():
                        doc = await get_latest(bvid, cid)
                        if doc:
                            text = doc.get("content", "")
                    if not text:
                        raise Exception(f"ASR completed but no content saved for bvid={bvid}, cid={cid}")

                title = page_title or page.page_title or f"P{page_index + 1}"

                video = VideoContent(
                    bvid=bvid, title=title, content=text, source=ContentSource.ASR,
                )

            chunk_count = self.rag.add_video_content(
                video=video, page_index=page_index, page_title=title,
            )

            # === Phase 5: confirm done ===
            async with get_db_context() as db:
                result = await db.execute(
                    select(Video).where(Video.bvid == bvid, Video.cid == cid)
                )
                page = result.scalar_one_or_none()
                page.is_vectorized = "done"
                page.vectorized_at = datetime.utcnow()
                page.vector_chunk_count = chunk_count
                await db.commit()

            await self.tracker.complete(task_id, result={"chunk_count": chunk_count})
            from app.services.video.service import _invalidate_video_pages
            await _invalidate_video_pages(bvid)
            logger.info(f"[VecPage] done bvid={bvid}, cid={cid}, chunks={chunk_count}")

        except Exception as e:
            logger.error(f"[VecPage] failed bvid={bvid}, cid={cid}: {e}")
            await self.tracker.fail(task_id, str(e))
            from app.services.video.service import _invalidate_video_pages
            await _invalidate_video_pages(bvid)
            try:
                async with get_db_context() as db:
                    result = await db.execute(
                        select(Video).where(Video.bvid == bvid, Video.cid == cid)
                    )
                    page = result.scalar_one_or_none()
                    if page:
                        page.is_vectorized = "failed"
                        page.vector_error = str(e)
                        await db.commit()
            except Exception as db_err:
                logger.error(f"[VecPage] failed to update page status: {db_err}")
            raise

    async def _run_asr(self, bvid: str, cid: int, page_index: int, page_title: str):
        """Run ASR via ASRPageService (poll for completion, max 5 minutes)."""
        from app.services.asr_page_service import ASRPageService
        from app.routers.asr import asr_tasks

        service = ASRPageService()
        task_id = str(uuid.uuid4())
        asr_tasks[task_id] = {"status": "pending", "progress": 0, "message": "ASR task created"}

        await service.process_page(
            task_id=task_id, bvid=bvid, cid=cid,
            page_index=page_index, page_title=page_title,
        )

        for _ in range(300):
            task = asr_tasks.get(task_id)
            if task and task["status"] in ("done", "failed"):
                if task["status"] == "failed":
                    raise Exception(f"ASR failed: {task.get('message', 'unknown')}")
                break
            await asyncio.sleep(1)

    def _delete_page_vectors(self, bvid: str, page_index: int):
        """Delete vectors for a specific page (not the entire bvid)."""
        self.rag.delete_page_vectors(bvid, page_index)

    def _content_changed(self, page: Video) -> bool:
        """Check if content has changed (for idempotency)."""
        return False  # Future: compare content hash
