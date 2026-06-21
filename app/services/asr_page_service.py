"""
Bilibili RAG 知识库系统

ASR 分P服务 - 仅做 ASR 转写，不涉及 RAG 向量存储

Storage: ASR text → MongoDB (asr_documents), metadata → MySQL (video + video_versions).
If MongoDB is disabled, falls back to MySQL video.content column.
"""
import asyncio
import os
import time
from datetime import datetime, timezone
from typing import Optional
from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.asr import ASRService
from app.services.bilibili import BilibiliService
from app.services.async_task.asr_task_registry import asr_tasks, create_task
from app.database import get_db_context
from app.models import Video, VideoVersion
from app.infra.mongo import is_enabled as mongo_enabled
from app.utils.bvid import bv_to_av

# Strong refs for background tasks — prevents asyncio from GC'ing them mid-run.
_background_tasks: set[asyncio.Task] = set()


class ContentSource:
    """内容来源枚举"""
    ASR = "asr"
    USER_EDIT = "user_edit"


class ASRPageService:
    """
    分P ASR 处理服务

    职责：
    1. 获取单P视频音频（本地下载，不依赖过期URL）
    2. ASR 转写
    3. 写入 video + video_versions

    不涉及：RAG 向量存储（那是独立流程）
    """

    def __init__(self):
        self.asr = ASRService()
        # bilibili_service 在运行时注入
        self.bili: Optional[BilibiliService] = None

    def set_bilibili_service(self, bili: BilibiliService):
        """设置 B站 服务（运行时注入）"""
        self.bili = bili

    # ── CRUD methods (called by router) ────────────────────────────

    async def get_content(self, bvid: str, cid: int, db: AsyncSession):
        """Query ASR content — MongoDB first, MySQL fallback."""
        from app.response import ASRContentResponse

        result = await db.execute(
            select(Video).where(Video.bvid == bvid, Video.cid == cid)
        )
        page = result.scalar_one_or_none()
        if not page:
            return ASRContentResponse(exists=False)

        content = None
        content_source = page.content_source
        version = page.version

        if mongo_enabled() and page.is_processed:
            try:
                from app.repository.mongo_asr_repository import get_latest
                mongo_doc = await get_latest(bvid, cid)
                if mongo_doc:
                    content = mongo_doc.get("content")
                    content_source = mongo_doc.get("content_source", content_source)
                    version = mongo_doc.get("version", version)
            except Exception as e:
                logger.warning(f"[ASR] MongoDB read failed: {e}")

        return ASRContentResponse(
            exists=True,
            bvid=page.bvid,
            cid=page.cid,
            page_index=page.page_index,
            page_title=page.page_title,
            content=content,
            content_source=content_source,
            version=version,
            is_processed=page.is_processed,
        )

    async def create_task(
        self,
        bvid: str,
        cid: int,
        page_index: int,
        page_title: Optional[str],
        uid: int,
        db: AsyncSession,
    ) -> dict:
        """Idempotent ASR task creation.

        - Existing & is_processed=True → return immediately, no task spawned.
        - Not existing → create Video row + spawn background task.
        - Existing & not processed → spawn background task on existing row.
        """
        result = await db.execute(
            select(Video).where(Video.bvid == bvid, Video.page_index == page_index)
        )
        existing = result.scalar_one_or_none()

        if existing and existing.is_processed:
            return {
                "task_id": None,
                "message": "ASR 已完成",
                "version": existing.version,
            }

        if not existing:
            new_page = Video(
                bvid=bvid,
                cid=cid,
                page_index=page_index,
                page_title=page_title or f"P{page_index + 1}",
                is_processed=False,
                version=1,
            )
            db.add(new_page)
            await db.commit()

        task_id = create_task(uid=uid)
        self._spawn_process_page(task_id, bvid, cid, page_index, page_title or f"P{page_index + 1}")
        return {"task_id": task_id, "message": "ASR 任务已创建"}

    async def update_content(
        self,
        bvid: str,
        page_index: int,
        content: str,
        db: AsyncSession,
    ) -> None:
        """Overwrite ASR content (user edit, no new version)."""
        result = await db.execute(
            select(Video).where(Video.bvid == bvid, Video.page_index == page_index)
        )
        page = result.scalar_one_or_none()
        if not page:
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail="ASR 记录不存在")

        page.content_source = "user_edit"
        page.is_processed = True
        page.updated_at = datetime.now(timezone.utc)
        await db.commit()

        if mongo_enabled():
            try:
                from app.repository.mongo_asr_repository import save_asr
                await save_asr(
                    video_id=bv_to_av(bvid),
                    bvid=bvid, cid=page.cid, page_index=page_index,
                    page_title=page.page_title or "",
                    content=content, content_source="user_edit",
                )
            except Exception as e:
                logger.warning(f"[ASR] MongoDB save failed on user edit: {e}")

    async def reasr(
        self,
        bvid: str,
        page_index: int,
        uid: int,
        db: AsyncSession,
    ) -> dict:
        """Force re-ASR (creates a new version)."""
        result = await db.execute(
            select(Video).where(Video.bvid == bvid, Video.page_index == page_index)
        )
        page = result.scalar_one_or_none()
        if not page:
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail="ASR 记录不存在")

        old_version = page.version

        # Snapshot the old version (metadata only; full text lives in MongoDB).
        db.add(VideoVersion(
            bvid=bvid,
            cid=page.cid,
            page_index=page.page_index,
            version=old_version,
            content_source=page.content_source,
            is_latest=False,
        ))

        page.version = old_version + 1
        page.is_processed = False
        page.content_source = None
        page.updated_at = datetime.now(timezone.utc)
        await db.commit()

        task_id = create_task(uid=uid)
        self._spawn_process_page(
            task_id, bvid, page.cid, page.page_index,
            page.page_title or f"P{page.page_index + 1}",
        )
        return {"task_id": task_id, "message": "重新 ASR 已启动"}

    async def get_task_status(self, task_id: str, uid: int):
        """Return task status dict; raises 404 if not found, 403 if not owner."""
        from fastapi import HTTPException
        from app.response import ASRTaskStatus

        if task_id not in asr_tasks:
            raise HTTPException(status_code=404, detail="任务不存在")
        task = asr_tasks[task_id]
        # IDOR guard: in-memory tasks created via create_task(uid=...) carry
        # the owner uid. Tasks without uid (legacy/internal) remain pollable.
        task_uid = task.get("uid")
        if task_uid is not None and task_uid != uid:
            raise HTTPException(status_code=403, detail="无权访问此任务")
        return ASRTaskStatus(
            task_id=task_id,
            status=task["status"],
            progress=task["progress"],
            message=task["message"],
        )

    async def list_versions(self, bvid: str, cid: int, db: AsyncSession) -> list:
        """Query version history — MongoDB first, MySQL fallback."""
        from app.response import VideoVersionInfo

        if mongo_enabled():
            try:
                from app.repository.mongo_asr_repository import list_versions
                docs = await list_versions(bvid, cid)
                if docs:
                    return [
                        VideoVersionInfo(
                            version=d.get("version", 1),
                            content_source=d.get("content_source", "unknown"),
                            content_preview=(d.get("content") or "")[:100],
                            is_latest=d.get("is_latest", False),
                            created_at=d.get("created_at", datetime.now(timezone.utc)),
                        )
                        for d in docs
                    ]
            except Exception as e:
                logger.warning(f"[ASR] MongoDB versions read failed, using MySQL: {e}")

        result = await db.execute(
            select(VideoVersion)
            .where(VideoVersion.bvid == bvid, VideoVersion.cid == cid)
            .order_by(VideoVersion.version.desc())
        )
        versions = result.scalars().all()
        return [
            VideoVersionInfo(
                version=v.version,
                content_source=v.content_source or "unknown",
                content_preview=(v.content or "")[:100],
                is_latest=v.is_latest,
                created_at=v.created_at,
            )
            for v in versions
        ]

    def _spawn_process_page(
        self,
        task_id: str,
        bvid: str,
        cid: int,
        page_index: int,
        page_title: str,
    ) -> None:
        """Spawn process_page as a strongly-referenced background task."""
        coro = self.process_page(
            task_id=task_id, bvid=bvid, cid=cid,
            page_index=page_index, page_title=page_title,
        )
        task = asyncio.create_task(coro)
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)

    async def process_page(
        self,
        task_id: str,
        bvid: str,
        cid: int,
        page_index: int,
        page_title: str,
    ):
        """
        后台 ASR 处理流程（仅此而已）：
        1. 更新任务状态 = processing
        2. 获取音频 URL 并下载到本地
        3. ASR 转写（本地文件上传，避免 URL 过期 403）
        4. 写入 video.content
        5. 写入 video_versions（新版本）
        6. 更新任务状态 = done
        7. 清理临时文件

        不涉及 RAG 向量存储（那是独立流程）
        """
        tmp_file = None
        try:
            # 更新任务状态
            asr_tasks[task_id]["status"] = "processing"
            asr_tasks[task_id]["progress"] = 10
            asr_tasks[task_id]["message"] = "获取音频..."

            # 获取音频 URL
            if not self.bili:
                self.bili = BilibiliService()

            audio_url = await self.bili.get_audio_url(bvid, cid)
            if not audio_url:
                raise Exception(f"无法获取音频 URL: bvid={bvid}, cid={cid}")

            asr_tasks[task_id]["progress"] = 25
            asr_tasks[task_id]["message"] = "Downloading audio..."
            # 下载到本地（避免 URL 过期导致 403）
            tmp_dir = os.path.join("data", "asr_tmp")
            os.makedirs(tmp_dir, exist_ok=True)

            tmp_file = os.path.join(tmp_dir, f"{bvid}_{cid}_{int(time.time())}.m4s")
            ok = await self.bili.download_audio_to_file(audio_url, tmp_file)
            if not ok or not os.path.exists(tmp_file):
                raise Exception(f"音频下载失败: bvid={bvid}, cid={cid}")

            file_size = os.path.getsize(tmp_file)
            if file_size < 1024:
                raise Exception(f"音频文件过小({file_size} bytes): bvid={bvid}, cid={cid}")

            asr_tasks[task_id]["progress"] = 55
            asr_tasks[task_id]["message"] = "Running ASR..."

            # ASR 转写（本地文件上传，避免 URL 过期 403）
            text = await self.asr.transcribe_local_file(tmp_file)
            if not text or len(text) < 50:
                raise Exception(f"ASR 内容过少: {len(text) if text else 0} 字符")

            asr_tasks[task_id]["progress"] = 85
            asr_tasks[task_id]["message"] = "Writing to database..."

            video_id = bv_to_av(bvid)

            # Write ASR content to MongoDB (primary store for full text)
            if mongo_enabled():
                try:
                    from app.repository.mongo_asr_repository import save_asr
                    await save_asr(
                        video_id=video_id,
                        bvid=bvid,
                        cid=cid,
                        page_index=page_index,
                        page_title=page_title,
                        content=text,
                        content_source="asr",
                        version=1,
                    )
                except Exception as e:
                    logger.warning(f"[ASR] MongoDB write failed, falling back to MySQL: {e}")

            # Write metadata to MySQL
            async with get_db_context() as db:
                from sqlalchemy import select
                result = await db.execute(
                    select(Video).where(Video.bvid == bvid, Video.cid == cid)
                )
                page = result.scalar_one_or_none()

                if page:
                    page.content_source = "asr"
                    page.is_processed = True
                    page.version = (page.version or 0) + 1

                    # Version history record (metadata only, full text in MongoDB)
                    version_record = VideoVersion(
                        bvid=bvid,
                        cid=cid,
                        page_index=page_index,
                        version=page.version,
                        content_source="asr",
                        is_latest=True,
                    )
                    db.add(version_record)

                    # Mark old versions as not latest
                    old_result = await db.execute(
                        select(VideoVersion)
                        .where(
                            VideoVersion.bvid == bvid,
                            VideoVersion.cid == cid,
                            VideoVersion.version < page.version
                        )
                    )
                    old_versions = old_result.scalars().all()
                    for old_v in old_versions:
                        old_v.is_latest = False

                    await db.commit()

            # 完成
            asr_tasks[task_id]["status"] = "done"
            asr_tasks[task_id]["progress"] = 100
            asr_tasks[task_id]["message"] = "ASR 完成"
            logger.info(f"[ASR] 完成 bvid={bvid}, cid={cid}, 长度={len(text)}")

        except Exception as e:
            logger.error(f"[ASR] 失败 bvid={bvid}, cid={cid}: {e}")
            asr_tasks[task_id]["status"] = "failed"
            asr_tasks[task_id]["message"] = f"ASR 失败: {str(e)}"

            # 尝试更新数据库状态
            try:
                async with get_db_context() as db:
                    from sqlalchemy import select
                    result = await db.execute(
                        select(Video).where(Video.bvid == bvid, Video.cid == cid)
                    )
                    page = result.scalar_one_or_none()
                    if page:
                        page.is_processed = True  # 标记为已处理（即使失败）
                        await db.commit()
            except Exception as db_err:
                logger.error(f"[ASR] 更新数据库失败: {db_err}")

        finally:
            # 清理临时文件
            if tmp_file and os.path.exists(tmp_file):
                try:
                    os.remove(tmp_file)
                    logger.debug(f"[ASR] 清理临时文件: {tmp_file}")
                except Exception as e:
                    logger.warning(f"[ASR] 清理临时文件失败: {e}")
