"""
Knowledge router — thin HTTP layer over KnowledgeSyncService,
KnowledgeBuildService, and KnowledgeRepository.

Owns: parameter parsing, dependency injection, response marshalling,
cache wiring, B站 service acquisition.
Owns NOT: DB operations, vector store access, background task orchestration.
"""
import re
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Depends
from loguru import logger
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db, get_db_context
from app.infra.errors import internal_error
from app.response.knowledge import VideoInfo, VideosResponse
from app.services.bilibili import BilibiliService
from app.services.asr import ASRService
from app.services.content_fetcher import ContentFetcher
from app.services.rag import get_rag_service
from app.routers.auth import get_current_uid, require_admin, _get_bili_cookies_by_uid
from app.utils.cache import cache_dependency_singleton

# Re-export for existing importers (chat.py imports get_rag_service from here).
__all__ = [
    "router",
    "get_rag_service",
    "PAGES_CACHE_KEY",
    "PAGES_CACHE_TTL",
    "BuildRequest",
    "BuildStatus",
    "FolderStatus",
    "SyncRequest",
    "SyncResult",
    "VectorizedPageItem",
]

router = APIRouter(prefix="/knowledge", tags=["知识库"])


# ---------------------------------------------------------------------------
# Request / response schemas (kept here — they're the HTTP contract)
# ---------------------------------------------------------------------------


class BuildRequest(BaseModel):
    folder_ids: List[int]
    exclude_bvids: Optional[List[str]] = None


class BuildStatus(BaseModel):
    task_id: str
    status: str
    progress: int
    current_step: str
    total_videos: int
    processed_videos: int
    message: str


class FolderStatus(BaseModel):
    media_id: int
    indexed_count: int
    media_count: Optional[int] = None
    last_sync_at: Optional[datetime] = None


class SyncRequest(BaseModel):
    folder_ids: Optional[List[int]] = None


class SyncResult(BaseModel):
    folder_id: int
    total: int
    added: int
    removed: int
    indexed: int
    message: str
    last_sync_at: Optional[datetime] = None


class VectorizedPageItem(BaseModel):
    bvid: str
    cid: int
    page_index: int
    page_title: Optional[str] = None
    video_title: Optional[str] = None
    vector_chunk_count: int = 0
    vectorized_at: Optional[datetime] = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/stats")
async def get_knowledge_stats(uid: int = Depends(get_current_uid)):
    """获取知识库统计信息"""
    try:
        rag = get_rag_service()
        return rag.get_collection_stats()
    except Exception as e:
        raise internal_error(e)


@router.get("/folders/status", response_model=List[FolderStatus])
async def get_folder_status(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """获取收藏夹入库状态 — 按「所有分P均已向量化」的视频数统计"""
    from app.repository.knowledge_repository import get_knowledge_repository

    # Redis cache (30s TTL)
    try:
        from app.infra.redis import (
            client as _redis,
            k as _rk,
            jget as _rjget,
            jset as _rjset,
        )
        cache_key = _rk("folder_status", str(uid))
        if _redis:
            cached = await _rjget(cache_key)
            if cached:
                return [FolderStatus(**item) for item in cached]
    except Exception:
        pass

    rows = await get_knowledge_repository().list_folder_status(uid, db)
    result = [FolderStatus(**r) for r in rows]

    try:
        if _redis:
            await _rjset(
                cache_key, [r.model_dump() for r in result], ex=30
            )
    except Exception:
        pass

    return result


@router.get("/pages/vectorized", response_model=List[VectorizedPageItem])
async def get_vectorized_pages(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Get vectorized pages for the current user (uid-scoped)."""
    from app.repository.knowledge_repository import get_knowledge_repository

    rows = await get_knowledge_repository().list_vectorized_pages(uid, db)
    return [VectorizedPageItem(**r) for r in rows]


@router.post("/folders/sync", response_model=List[SyncResult])
async def sync_folders(
    request: SyncRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """同步收藏夹到向量库"""
    from app.services.knowledge_build import KnowledgeSyncService

    bili, bili_mid = await _get_bili_cookies_by_uid(uid, db)
    rag = get_rag_service()
    asr_service = ASRService()
    content_fetcher = ContentFetcher(bili, asr_service)
    sync_service = KnowledgeSyncService()

    try:
        folder_ids = request.folder_ids or []
        if not folder_ids:
            folders = await bili.get_user_favorites(mid=bili_mid)
            folder_ids = [f.get("id") for f in folders if f.get("id")]

        results: List[SyncResult] = []
        for folder_id in folder_ids:
            try:
                result = await sync_service.sync_folder(
                    db, bili, rag, content_fetcher, uid, folder_id
                )
                results.append(SyncResult(**result))
            except Exception as e:
                logger.exception("Folder sync failed folder_id={}", folder_id)
                results.append(
                    SyncResult(
                        folder_id=folder_id,
                        total=0,
                        added=0,
                        removed=0,
                        indexed=0,
                        message=f"同步失败: {e}",
                        last_sync_at=None,
                    )
                )

        return results
    finally:
        await bili.close()


@router.post("/build")
async def build_knowledge_base(
    request: BuildRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """构建知识库（后台任务）。

    全局单例：同一进程同一时刻只允许一个 build 任务在跑。重复点击直接
    复用当前活跃的 task_id，避免对 B站 CDN 的并发请求触发限流。
    """
    from app.services.knowledge_build import get_build_service

    bili, _bili_mid = await _get_bili_cookies_by_uid(uid, db)
    sessdata = bili.sessdata
    await bili.close()

    return await get_build_service().try_start_build(
        uid=uid,
        folder_ids=request.folder_ids,
        exclude_bvids=request.exclude_bvids or [],
        sessdata=sessdata,
    )


@router.get("/build/active")
async def get_active_build_task(uid: int = Depends(get_current_uid)):
    """查询当前是否有活跃的 build 任务（前端用来禁用按钮 / 复用 task_id）。"""
    from app.services.knowledge_build import get_build_service

    return get_build_service().get_active_build(uid)


@router.get("/build/status/{task_id}", response_model=BuildStatus)
async def get_build_status(task_id: str, uid: int = Depends(get_current_uid)):
    """获取构建任务状态 — async_tasks 表优先，build_tasks 内存兜底"""
    from app.repository.knowledge_repository import get_knowledge_repository
    from app.services.knowledge_build.build_service import build_tasks

    # 1. Try async_tasks table (persisted)
    try:
        async with get_db_context() as db:
            row = await get_knowledge_repository().get_build_status_row(
                task_id, uid, db
            )
            if row:
                current_step = ""
                if row.steps:
                    last = row.steps[-1] if row.steps else {}
                    current_step = last.get("name", "")
                folder_ids = (row.target or {}).get("folder_ids") or []
                return BuildStatus(
                    task_id=task_id,
                    status=row.status or "pending",
                    progress=row.progress or 0,
                    current_step=current_step,
                    total_videos=len(folder_ids),
                    processed_videos=len(row.steps or []),
                    message=row.error or "",
                )
    except Exception as e:
        logger.warning(f"[BuildStatus] async_tasks read failed: {e}")

    # 2. Fallback: in-memory build_tasks (legacy)
    if task_id not in build_tasks:
        raise HTTPException(status_code=404, detail="任务不存在")

    task = build_tasks[task_id]
    return BuildStatus(
        task_id=task_id,
        status=task["status"],
        progress=task["progress"],
        current_step=task["current_step"],
        total_videos=task["total_videos"],
        processed_videos=task["processed_videos"],
        message=task["message"],
    )


@router.delete("/clear")
async def clear_knowledge_base(uid: int = Depends(require_admin)):
    """清空知识库（全局破坏性操作，仅管理员）"""
    try:
        rag = get_rag_service()
        rag.clear_collection()
        return {"message": "知识库已清空"}
    except Exception as e:
        raise internal_error(e)


@router.delete("/video/{bvid}")
async def delete_video_from_knowledge(
    bvid: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """从知识库中删除指定视频。

    安全约束：bvid 必须属于当前用户的某个有效收藏夹（通过 collection +
    favorite_folder 联表校验），否则拒绝。管理员旁路。
    """
    from app.repository.knowledge_repository import get_knowledge_repository
    from app.repository.rbac_repository import get_rbac_repository

    try:
        if not await get_knowledge_repository().bvid_belongs_to_user(
            bvid, uid, db
        ):
            roles = await get_rbac_repository().get_user_roles(uid, db)
            if "admin" not in roles:
                raise HTTPException(
                    status_code=403,
                    detail="无权删除：该视频不在你的收藏夹中",
                )

        rag = get_rag_service()
        rag.delete_video(bvid)
        return {"message": f"已删除视频 {bvid}"}
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e)


# ==================== 视频分P旁路缓存 ====================

PAGES_CACHE_KEY = "video:pages:{bvid}"
PAGES_CACHE_TTL = 86400  # 24小时


@router.get("/video/{bvid}/pages", response_model=VideosResponse, deprecated=True)
async def get_video(
    bvid: str,
    cache=Depends(cache_dependency_singleton()),
    uid: int = Depends(get_current_uid),
):
    """获取视频全部分P信息（旁路缓存策略）"""
    if not re.match(r"^[Bb][Vv][a-zA-Z0-9]{10}$", bvid):
        raise HTTPException(status_code=400, detail="Invalid bvid format")

    cache_key = PAGES_CACHE_KEY.format(bvid=bvid)
    cached = cache.get(cache_key)
    if cached:
        return VideosResponse(**cached)

    bili = BilibiliService()
    try:
        video_info = await bili.get_video_info(bvid)
    except Exception:
        logger.exception("[PAGES] Bilibili API call failed bvid={}", bvid)
        raise HTTPException(status_code=502, detail="B站 API 调用失败，请稍后重试")
    finally:
        await bili.close()

    pages_raw = video_info.get("pages") or []
    page_count = len(pages_raw) if pages_raw else 1

    data = {
        "bvid": bvid,
        "title": video_info.get("title", ""),
        "pages": [
            VideoInfo(
                cid=p.get("cid"),
                page=p.get("page"),
                title=p.get("part", ""),
                duration=p.get("duration", 0),
            )
            for p in pages_raw
        ],
        "page_count": page_count,
    }

    try:
        cache.set(cache_key, data)
    except Exception as e:
        logger.warning(f"[PAGES] 缓存写入失败 bvid={bvid}: {e}")

    return VideosResponse(**data)
