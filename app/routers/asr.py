"""
Bilibili RAG 知识库系统

ASR 路由 - 分P视频语音转文本
"""
import uuid
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Video, VideoVersion
from app.response import (
    ASRCreateRequest, ASRUpdateRequest, ASRReASRRequest,
    ASRContentResponse, ASRTaskStatus, VideoVersionInfo,
)

router = APIRouter(prefix="/asr", tags=["ASR"])

# 内存任务状态存储
asr_tasks: dict = {}


def _create_task() -> str:
    """创建新任务并返回 task_id"""
    task_id = str(uuid.uuid4())
    asr_tasks[task_id] = {
        "status": "pending",
        "progress": 0,
        "message": "任务已创建",
        "result": None,
    }
    return task_id


# ==================== 依赖注入 ====================

def get_ASRPageService():
    """延迟导入 ASRPageService，避免循环依赖"""
    from app.services.asr_page_service import ASRPageService
    return ASRPageService()


# ==================== API 接口 ====================

@router.get("/content")
async def get_asr_content(
    bvid: str,
    cid: int,
    db: AsyncSession = Depends(get_db)
) -> ASRContentResponse:
    """Query ASR content — MongoDB first, MySQL fallback."""
    result = await db.execute(
        select(Video).where(Video.bvid == bvid, Video.cid == cid)
    )
    page = result.scalar_one_or_none()

    if not page:
        return ASRContentResponse(exists=False)

    content = None
    content_source = page.content_source
    version = page.version

    # MongoDB is the sole store for full text
    from app.infra.mongo import is_enabled as mongo_enabled
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


@router.post("/create")
async def create_asr(
    req: ASRCreateRequest,
    db: AsyncSession = Depends(get_db),
    service = Depends(get_ASRPageService)
):
    """
    幂等创建 ASR 任务
    - 已存在且 is_processed=true → 直接返回
    - 不存在 → 创建记录 + 后台任务
    """
    # 查询是否已存在（唯一约束是 bvid+page_index，非 bvid+cid）
    result = await db.execute(
        select(Video).where(Video.bvid == req.bvid, Video.page_index == req.page_index)
    )
    existing = result.scalar_one_or_none()

    if existing and existing.is_processed:
        # 已完成，直接返回
        return {
            "task_id": None,
            "message": "ASR 已完成",
            "version": existing.version,
        }

    # 不存在则创建记录
    if not existing:
        new_page = Video(
            bvid=req.bvid,
            cid=req.cid,
            page_index=req.page_index,
            page_title=req.page_title or f"P{req.page_index + 1}",
            is_processed=False,
            version=1,
        )
        db.add(new_page)
        await db.commit()

    # 创建后台任务
    task_id = _create_task()

    # 启动后台 ASR 处理
    import asyncio
    asyncio.create_task(
        service.process_page(
            task_id=task_id,
            bvid=req.bvid,
            cid=req.cid,
            page_index=req.page_index,
            page_title=req.page_title or f"P{req.page_index + 1}",
        )
    )

    return {"task_id": task_id, "message": "ASR 任务已创建"}


@router.post("/update")
async def update_asr_content(
    req: ASRUpdateRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    手动编辑更新（覆盖，不新建版本）
    """
    result = await db.execute(
        select(Video).where(Video.bvid == req.bvid, Video.page_index == req.page_index)
    )
    page = result.scalar_one_or_none()

    if not page:
        raise HTTPException(status_code=404, detail="ASR 记录不存在")

    # Save to MongoDB (primary), update MySQL metadata
    page.content_source = "user_edit"
    page.is_processed = True
    page.updated_at = datetime.utcnow()
    await db.commit()

    from app.infra.mongo import is_enabled as _mongo_ok
    if _mongo_ok():
        try:
            from app.repository.mongo_asr_repository import save_asr
            from app.utils.bvid import bv_to_av
            await save_asr(
                video_id=bv_to_av(req.bvid),
                bvid=req.bvid, cid=page.cid, page_index=req.page_index,
                page_title=page.page_title or "",
                content=req.content, content_source="user_edit",
            )
        except Exception as e:
            logger.warning(f"[ASR] MongoDB save failed on user edit: {e}")

    return {"success": True, "message": "更新成功"}


@router.post("/reasr")
async def reasr(
    req: ASRReASRRequest,
    db: AsyncSession = Depends(get_db),
    service = Depends(get_ASRPageService)
):
    """
    强制重新 ASR（新建版本）
    """
    # 查询现有记录（唯一约束是 bvid+page_index，非 bvid+cid）
    result = await db.execute(
        select(Video).where(Video.bvid == req.bvid, Video.page_index == req.page_index)
    )
    page = result.scalar_one_or_none()

    if not page:
        raise HTTPException(status_code=404, detail="ASR 记录不存在")

    # 旧版本 is_latest = false
    old_version = page.version

    # Insert version record (metadata only)
    new_version_record = VideoVersion(
        bvid=req.bvid,
        cid=req.cid,
        page_index=page.page_index,
        version=old_version,
        content_source=page.content_source,
        is_latest=False,
    )
    db.add(new_version_record)

    # Reset page for re-ASR
    page.version = old_version + 1
    page.is_processed = False
    page.content_source = None
    page.updated_at = datetime.utcnow()

    await db.commit()

    # 创建后台任务
    task_id = _create_task()

    # 启动后台 ASR 处理
    import asyncio
    asyncio.create_task(
        service.process_page(
            task_id=task_id,
            bvid=req.bvid,
            cid=req.cid,
            page_index=page.page_index,
            page_title=page.page_title or f"P{page.page_index + 1}",
        )
    )

    return {"task_id": task_id, "message": "重新 ASR 已启动"}


@router.get("/status/{task_id}")
async def get_task_status(task_id: str) -> ASRTaskStatus:
    """轮询任务状态"""
    if task_id not in asr_tasks:
        raise HTTPException(status_code=404, detail="任务不存在")

    task = asr_tasks[task_id]
    return ASRTaskStatus(
        task_id=task_id,
        status=task["status"],
        progress=task["progress"],
        message=task["message"],
    )


@router.get("/versions")
async def get_versions(
    bvid: str,
    cid: int,
    db: AsyncSession = Depends(get_db)
) -> list[VideoVersionInfo]:
    """Query version history — MongoDB first, MySQL fallback."""
    from app.infra.mongo import is_enabled as mongo_enabled

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
                        created_at=d.get("created_at", datetime.utcnow()),
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
