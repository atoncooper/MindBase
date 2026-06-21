"""
Per-page vectorization service — atomic protection + step-level progress.
"""

import asyncio
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException
from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db_context
from app.models import Video
from app.response.knowledge import VideoContent, ContentSource
from app.services.async_task.tracker import TaskTracker


# Strong refs for background tasks (prevents asyncio GC).
_background_tasks: set[asyncio.Task] = set()


async def _invalidate_vec_status_cache(bvid: str, cid: int):
    """Invalidate cached vector status after change."""
    try:
        from app.infra.redis import client as _redis, k
        if _redis:
            await _redis.delete(k("vec_status", f"{bvid}:{cid}"))
    except Exception:
        pass


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

    # ── CRUD methods (called by router) ────────────────────────────

    async def get_status(
        self, bvid: str, cid: int, db: AsyncSession
    ) -> dict:
        """Return vectorization status with cross-store self-heal.

        - If MySQL says 'done' but Milvus has 0 chunks → flip to 'failed'.
        - If MySQL says 'pending' but Milvus has chunks → flip to 'done'.
        - If MySQL says processed but MongoDB has no content → flip to not processed.
        """
        # 1. Redis cache (30s TTL)
        try:
            from app.infra.redis import client as _redis, k, jget
            if _redis:
                cached = await jget(k("vec_status", f"{bvid}:{cid}"))
                if cached:
                    return cached
        except Exception:
            pass

        result = await db.execute(
            select(Video).where(Video.bvid == bvid, Video.cid == cid)
        )
        page = result.scalar_one_or_none()
        if not page:
            return {
                "exists": False,
                "is_processed": False,
                "is_vectorized": "pending",
                "vector_chunk_count": 0,
            }

        need_commit = False
        vector_exists = False
        content_exists = False
        content_preview: Optional[str] = None

        actual_count = self.rag.get_page_vector_count(bvid, page.page_index)
        vector_exists = actual_count > 0

        if page.is_vectorized == "done" and actual_count == 0:
            page.is_vectorized = "failed"
            page.vector_error = (
                "Milvus vector count is 0 — data lost after DB migration"
            )
            need_commit = True
            vector_exists = False
        elif page.is_vectorized == "pending" and actual_count > 0:
            page.is_vectorized = "done"
            page.vectorized_at = datetime.now(timezone.utc)
            page.vector_chunk_count = actual_count
            need_commit = True
            vector_exists = True

        if page.is_processed:
            content_exists, content_preview = await self._check_mongo_content(
                bvid, cid
            )
            if not content_exists:
                page.is_processed = False
                need_commit = True

        if need_commit:
            await db.commit()

        resp = {
            "exists": True,
            "bvid": page.bvid,
            "cid": page.cid,
            "page_index": page.page_index,
            "page_title": page.page_title,
            "is_processed": page.is_processed,
            "content_preview": content_preview,
            "is_vectorized": (
                "failed"
                if (page.is_vectorized == "done" and not vector_exists)
                else page.is_vectorized
            ),
            "vectorized_at": page.vectorized_at,
            "vector_chunk_count": page.vector_chunk_count or actual_count,
            "vector_error": page.vector_error,
            "steps": None,
        }

        try:
            from app.infra.redis import client as _redis2, k as _k2, jset as _jset
            if _redis2:
                await _jset(
                    _k2("vec_status", f"{bvid}:{cid}"), resp, ex=30
                )
        except Exception:
            pass

        return resp

    async def create_task(
        self,
        bvid: str,
        cid: int,
        page_index: int,
        page_title: Optional[str],
        uid: int,
        db: AsyncSession,
    ) -> dict:
        """Idempotent vectorization — runs ASR first if needed, then vectors."""
        result = await db.execute(
            select(Video).where(Video.bvid == bvid, Video.cid == cid)
        )
        page = result.scalar_one_or_none()

        if not page:
            page = Video(
                bvid=bvid,
                cid=cid,
                page_index=page_index,
                page_title=page_title or f"P{page_index + 1}",
                is_processed=False,
                version=1,
                is_vectorized="pending",
                vector_chunk_count=0,
            )
            db.add(page)
            await db.commit()
            await db.refresh(page)

        if page.is_vectorized == "done":
            return {"task_id": None, "message": "Already up to date"}

        task_id = await self.tracker.create(
            uid=uid,
            task_type="vec_page",
            target={
                "bvid": bvid,
                "cid": cid,
                "page_index": page_index,
                "page_title": page_title or page.page_title,
            },
        )

        self._spawn_process_page_vectorization(
            task_id=task_id,
            bvid=bvid,
            cid=cid,
            page_index=page_index,
            page_title=page_title or page.page_title or f"P{page_index + 1}",
        )

        return {"task_id": task_id, "message": "Vectorization task created"}

    async def revector(
        self,
        bvid: str,
        cid: int,
        uid: int,
        db: AsyncSession,
    ) -> dict:
        """Force re-vectorization — deletes old vectors, creates new ones."""
        result = await db.execute(
            select(Video).where(Video.bvid == bvid, Video.cid == cid)
        )
        page = result.scalar_one_or_none()
        if not page:
            raise HTTPException(
                status_code=404, detail="Video page not found"
            )
        if not page.is_processed:
            raise HTTPException(
                status_code=400,
                detail="ASR not completed — cannot vectorize",
            )

        page.is_vectorized = "pending"
        page.vector_error = None
        await db.commit()

        task_id = await self.tracker.create(
            uid=uid,
            task_type="vec_page",
            target={
                "bvid": bvid,
                "cid": cid,
                "page_index": page.page_index,
                "page_title": page.page_title,
            },
        )

        self._spawn_process_page_vectorization(
            task_id=task_id,
            bvid=bvid,
            cid=cid,
            page_index=page.page_index,
            page_title=page.page_title or f"P{page.page_index + 1}",
        )

        return {"task_id": task_id, "message": "Re-vectorization task created"}

    async def get_task_status(self, task_id: str, uid: int) -> dict:
        """Poll task status with step-level progress. Enforces ownership."""
        async with get_db_context() as db:
            task = await self.tracker._repo.get_by_task_id(task_id, db)

        if not task:
            from app.services.async_task.asr_task_registry import asr_tasks
            asr_task = asr_tasks.get(task_id)
            if asr_task:
                # IDOR guard: in-memory tasks created via create_task(uid=...)
                # carry the owner uid. Tasks created without uid (legacy /
                # internal callers) remain pollable by any authenticated user.
                task_uid = asr_task.get("uid")
                if task_uid is not None and task_uid != uid:
                    raise HTTPException(
                        status_code=403, detail="无权访问此任务"
                    )
                return {
                    "task_id": task_id,
                    "status": asr_task["status"],
                    "progress": asr_task["progress"],
                    "message": asr_task["message"],
                    "steps": [
                        {
                            "name": "asr",
                            "status": asr_task["status"],
                            "progress": asr_task["progress"],
                        }
                    ],
                }
            raise HTTPException(status_code=404, detail="Task not found")

        if task.uid is not None and task.uid != uid:
            raise HTTPException(status_code=403, detail="无权访问此任务")

        status = task.status
        if status == "done":
            message = "Complete"
        elif status == "failed":
            message = f"Failed: {task.error or 'unknown'}"
        elif status == "processing":
            message = "Processing..."
        else:
            message = "Pending"

        return {
            "task_id": task.task_id,
            "status": status,
            "progress": task.progress or 0,
            "message": message,
            "steps": task.steps,
            "result": task.result,
            "error": task.error,
        }

    # ── helpers ────────────────────────────────────────────────────

    async def _check_mongo_content(
        self, bvid: str, cid: int
    ) -> tuple[bool, Optional[str]]:
        """Verify content exists in MongoDB. Returns (exists, preview)."""
        from app.infra.mongo import is_enabled as _mongo_ok
        if not _mongo_ok():
            return False, None
        from app.repository.mongo_asr_repository import get_latest
        doc = await get_latest(bvid, cid)
        if doc and doc.get("content") and len(doc["content"].strip()) >= 50:
            return True, doc["content"][:200]
        return False, None

    def _spawn_process_page_vectorization(
        self,
        task_id: str,
        bvid: str,
        cid: int,
        page_index: int,
        page_title: str,
    ) -> None:
        """Strongly-referenced background task spawn."""
        coro = self.process_page_vectorization(
            task_id=task_id,
            bvid=bvid,
            cid=cid,
            page_index=page_index,
            page_title=page_title,
        )
        task = asyncio.create_task(coro)
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)

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

                if page.is_vectorized == "processing":
                    logger.info(f"[VecPage] already in progress: bvid={bvid}, cid={cid}")
                    await self.tracker.complete(task_id, result={"skipped": True, "message": "Already in progress"})
                    return

                if page.is_vectorized == "done" and not self._content_changed(page):
                    await self.tracker.complete(task_id, result={"skipped": True, "message": "Already up to date"})
                    return

                page.is_vectorized = "processing"
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
                page.vectorized_at = datetime.now(timezone.utc)
                page.vector_chunk_count = chunk_count
                await db.commit()

            await self.tracker.complete(task_id, result={"chunk_count": chunk_count})
            from app.services.video.service import _invalidate_video_pages
            await _invalidate_video_pages(bvid)
            await _invalidate_vec_status_cache(bvid, cid)
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
        from app.services.async_task.asr_task_registry import asr_tasks, create_task

        service = ASRPageService()
        task_id = create_task()
        asr_tasks[task_id].update({"message": "ASR task created"})

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
