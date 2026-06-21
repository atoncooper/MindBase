"""Knowledge build service — orchestrates the multi-folder build background task.

Absorbs ``_build_knowledge_base_task``, ``legacy_state``, ``build_tasks``,
and the process-wide singleton lock (``_active_build_*``) from
``app/routers/knowledge.py``.

The singleton lock guarantees at most one build per process: B站 throttles
concurrent requests aggressively, and parallel builds hit the same SESSDATA
twice triggering RST mid-download.
"""
from __future__ import annotations

import asyncio
import random
from typing import Any, Optional

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db_context
from app.models import FavoriteFolder
from app.services.async_task.tracker import TaskTracker
from app.services.bilibili import BilibiliService
from app.services.content_fetcher import ContentFetcher
from app.services.asr import ASRService
from app.services.rag import get_rag_service
from app.services.knowledge_build.sync_service import KnowledgeSyncService


# Legacy in-memory build task state (kept for backward compat with older
# polling clients that don't read the async_tasks table).
build_tasks: dict[str, dict[str, Any]] = {}

# Strong refs for background tasks — prevents asyncio from GC'ing them
# mid-flight. Without this, _run_build_task could be collected at an await
# point, the singleton lock would never release, and every subsequent
# /knowledge/build call would "reuse" the dead task_id forever.
_background_tasks: set[asyncio.Task] = set()


def _spawn(coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


def legacy_state(
    task_id: str,
    status: str,
    step: str = "",
    progress: int = 0,
    processed: int = 0,
    total_videos: int = 0,
    message: str = "",
) -> None:
    """Update legacy in-memory build_tasks dict for backward compat."""
    t = build_tasks.setdefault(task_id, {})
    if status:
        t["status"] = status
    if step:
        t["current_step"] = step
    if progress is not None:
        t["progress"] = progress
    if processed:
        t["processed_videos"] = processed
    if total_videos:
        t["total_videos"] = total_videos
    if message:
        t["message"] = message


class KnowledgeBuildService:
    """Singleton-style orchestrator for the /knowledge/build background task."""

    def __init__(self) -> None:
        self._active_build_task_id: Optional[str] = None
        self._active_build_uid: Optional[int] = None
        self._lock = asyncio.Lock()
        self._sync_service = KnowledgeSyncService()

    def is_build_active(self) -> bool:
        return self._active_build_task_id is not None

    async def try_start_build(
        self,
        uid: int,
        folder_ids: list[int],
        exclude_bvids: list[str],
        sessdata: str,
    ) -> dict:
        """Acquire the singleton lock and schedule the build task.

        Returns ``{"task_id", "message", "reused"}``. If a build is already
        running, reuses that task_id instead of starting a new one.
        """
        async with self._lock:
            if self._active_build_task_id is not None:
                logger.info(
                    f"[build] reuse active task_id={self._active_build_task_id} "
                    f"uid={self._active_build_uid} (requested by uid={uid})"
                )
                return {
                    "task_id": self._active_build_task_id,
                    "message": "已有构建任务在运行，复用该任务",
                    "reused": True,
                }

            tracker = TaskTracker()
            task_id = await tracker.create(
                uid=uid,
                task_type="build",
                target={"folder_ids": folder_ids},
            )
            build_tasks[task_id] = build_tasks.get(task_id) or {
                "status": "pending",
                "progress": 0,
                "current_step": "初始化中...",
                "total_videos": 0,
                "processed_videos": 0,
                "message": "",
            }

            # Mark active BEFORE scheduling so a concurrent caller sees the lock taken.
            self._active_build_task_id = task_id
            self._active_build_uid = uid

        # Schedule the background task (strongly referenced via _spawn).
        _spawn(
            self._run_build_task(
                task_id, uid, sessdata, folder_ids, exclude_bvids
            )
        )

        return {"task_id": task_id, "message": "构建任务已启动", "reused": False}

    def get_active_build(self, uid: int) -> dict:
        """Return the currently active build task, if any."""
        if self._active_build_task_id is None:
            return {"active": False, "task_id": None, "uid": None}
        return {
            "active": True,
            "task_id": self._active_build_task_id,
            "uid": self._active_build_uid,
            "is_yours": self._active_build_uid == uid,
        }

    async def _run_build_task(
        self,
        task_id: str,
        uid: int,
        sessdata: str,
        folder_ids: list[int],
        exclude_bvids: list[str],
    ) -> None:
        """Background build task — writes to async_tasks table, broadcasts WS."""
        cursor: dict[str, Any] = {
            "folder_index": 0,
            "total_folders": 0,
            "folder_id": None,
            "folder_title": None,
            "video_index": 0,
            "total_videos_in_folder": 0,
            "current_video_title": None,
        }

        def _notify(status: str, **kwargs: Any) -> None:
            legacy_kwargs = {
                k: v
                for k, v in kwargs.items()
                if k in {"progress", "processed", "total_videos", "message"}
            }
            if "current_step" in kwargs:
                legacy_kwargs["step"] = kwargs["current_step"]
            legacy_state(task_id, status, **legacy_kwargs)
            try:
                from app.services.ws_registry import broadcast_task_update
                task_info = {
                    "task_id": task_id,
                    "task_type": "build",
                    "uid": uid,
                    "status": status,
                    **cursor,
                    **kwargs,
                }
                _spawn(broadcast_task_update(uid, task_info))
            except Exception:
                pass

        tracker = TaskTracker()

        try:
            await tracker.start(task_id)
            legacy_state(task_id, "running", "同步收藏夹...")

            bili = BilibiliService(sessdata=sessdata, bili_jct="")
            asr_service = ASRService()
            content_fetcher = ContentFetcher(bili, asr_service)
            rag = get_rag_service()

            try:
                total_folders = len(folder_ids)
                if total_folders == 0:
                    await tracker.complete(
                        task_id, {"message": "没有需要处理的收藏夹"}
                    )
                    _notify("done", progress=100, current_step="完成")
                    return

                total_added = 0
                total_removed = 0
                cursor["total_folders"] = total_folders

                async with get_db_context() as db:
                    for idx, folder_id in enumerate(folder_ids, start=1):
                        folder_progress = int((idx / total_folders) * 100)

                        folder_title: Optional[str] = None
                        try:
                            ff_row = await db.execute(
                                select(FavoriteFolder.title).where(
                                    FavoriteFolder.media_id == folder_id,
                                    FavoriteFolder.uid == uid,
                                )
                            )
                            folder_title = ff_row.scalar_one_or_none()
                        except Exception:
                            folder_title = None

                        cursor.update(
                            {
                                "folder_index": idx,
                                "folder_id": folder_id,
                                "folder_title": folder_title,
                                "video_index": 0,
                                "total_videos_in_folder": 0,
                                "current_video_title": None,
                            }
                        )

                        folder_label = folder_title or f"#{folder_id}"
                        await tracker.step(
                            task_id,
                            name=f"folder:{folder_id}",
                            status="processing",
                            progress=folder_progress,
                        )
                        _notify(
                            "running",
                            progress=folder_progress,
                            current_step=f"收藏夹 {idx}/{total_folders}：{folder_label}",
                        )

                        def progress_cb(
                            title: str, count: int = 0, total: int = 0
                        ) -> None:
                            cursor.update(
                                {
                                    "video_index": count,
                                    "total_videos_in_folder": total,
                                    "current_video_title": title,
                                }
                            )
                            legacy_state(
                                task_id,
                                "running",
                                step=f"处理: {title}",
                                processed=count,
                                total_videos=total,
                            )
                            _notify(
                                "running",
                                progress=folder_progress,
                                current_step=f"{folder_label} {count}/{total}：{title}",
                            )

                        result = await self._sync_service.sync_folder(
                            db,
                            bili,
                            rag,
                            content_fetcher,
                            uid,
                            folder_id,
                            exclude_bvids=set(exclude_bvids),
                            progress_callback=progress_cb,
                        )

                        total_added += result["added"]
                        total_removed += result["removed"]

                        if idx < total_folders:
                            wait_s = random.uniform(2.0, 5.0)
                            _notify(
                                "running",
                                progress=folder_progress,
                                current_step=f"等待 {wait_s:.1f}s 后处理下一个收藏夹",
                            )
                            await asyncio.sleep(wait_s)

                await tracker.complete(
                    task_id,
                    result={
                        "folders_processed": total_folders,
                        "videos_added": total_added,
                        "videos_removed": total_removed,
                    },
                )
                cursor.update(
                    {
                        "video_index": 0,
                        "total_videos_in_folder": 0,
                        "current_video_title": None,
                    }
                )
                _notify(
                    "done",
                    progress=100,
                    current_step="完成",
                    message=f"同步完成：新增 {total_added}，移除 {total_removed}",
                )

                try:
                    from app.infra.redis import client as _redis, k as _rk
                    if _redis:
                        await _redis.delete(_rk("folder_status", str(uid)))
                except Exception:
                    pass

                logger.info(
                    f"知识库构建完成: 新增 {total_added}，移除 {total_removed}"
                )
            finally:
                await bili.close()

        except Exception as e:
            logger.exception("Build task failed")
            await tracker.fail(task_id, str(e))
            _notify("failed", message=str(e))
        finally:
            async with self._lock:
                if self._active_build_task_id == task_id:
                    self._active_build_task_id = None
                    self._active_build_uid = None
                    logger.info(f"[build] released singleton task_id={task_id}")


# ── Module-level singleton ────────────────────────────────────────

_build_service: Optional[KnowledgeBuildService] = None


def get_build_service() -> KnowledgeBuildService:
    global _build_service
    if _build_service is None:
        _build_service = KnowledgeBuildService()
    return _build_service
