"""
Bilibili RAG 知识库系统

知识库路由 - 构建和管理知识库
"""
import asyncio
import random
import re
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, BackgroundTasks, Depends
from loguru import logger
from typing import List, Optional, Callable
from pydantic import BaseModel
from sqlalchemy import select, func, delete, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db, get_db_context
from app.models import FavoriteFolder, Collection, Video
from app.response.knowledge import ContentSource, VideoContent, VideoInfo, VideosResponse
from app.services.async_task.tracker import TaskTracker
from app.services.bilibili import BilibiliService
from app.services.content_fetcher import ContentFetcher
from app.services.asr import ASRService
from app.services.rag import RAGService, get_rag_service
from app.routers.auth import get_current_uid, _get_bili_cookies_by_uid
from app.utils.bvid import bv_to_av
from app.utils.cache import cache_dependency_singleton

router = APIRouter(prefix="/knowledge", tags=["知识库"])

# Build task state (legacy in-memory)
build_tasks = {}

# ---------------------------------------------------------------------------
# Process-wide singleton lock for /knowledge/build.
#
# B站 throttles concurrent requests aggressively. Letting two build jobs run
# in parallel hits the same SESSDATA twice and triggers RST mid-download.
# We keep at most ONE active build per process, identified by task_id.
# ---------------------------------------------------------------------------
_active_build_task_id: Optional[str] = None
_active_build_uid: Optional[int] = None
_active_build_lock = asyncio.Lock()


def _is_build_active() -> bool:
    """Whether a build task is currently in flight in this process."""
    return _active_build_task_id is not None


async def _human_pause(min_s: float, max_s: float) -> None:
    """Random sleep between min_s and max_s seconds — mimics human pacing."""
    await asyncio.sleep(random.uniform(min_s, max_s))


class BuildRequest(BaseModel):
    """知识库构建请求"""
    folder_ids: List[int]  # 要处理的收藏夹 ID 列表
    exclude_bvids: Optional[List[str]] = None  # 排除的视频


class BuildStatus(BaseModel):
    """构建状态"""
    task_id: str
    status: str  # pending / running / completed / failed
    progress: int  # 0-100
    current_step: str
    total_videos: int
    processed_videos: int
    message: str


class FolderStatus(BaseModel):
    """收藏夹入库状态"""
    media_id: int
    indexed_count: int
    media_count: Optional[int] = None
    last_sync_at: Optional[datetime] = None


class SyncRequest(BaseModel):
    """同步请求"""
    folder_ids: Optional[List[int]] = None


class SyncResult(BaseModel):
    """同步结果"""
    folder_id: int
    total: int
    added: int
    removed: int
    indexed: int
    message: str
    last_sync_at: Optional[datetime] = None


async def _get_or_create_folder(
    db: AsyncSession,
    uid: int,
    media_id: int,
    title: Optional[str] = None,
    media_count: Optional[int] = None,
) -> FavoriteFolder:
    """获取或创建收藏夹记录 (uid-based)"""
    result = await db.execute(
        select(FavoriteFolder).where(
            FavoriteFolder.uid == uid,
            FavoriteFolder.media_id == media_id,
        )
    )
    folder = result.scalar_one_or_none()

    if folder is None:
        folder = FavoriteFolder(
            uid=uid,
            media_id=media_id,
            title=title or "",
            media_count=media_count or 0,
            is_selected=True,
        )
        db.add(folder)
        await db.flush()
    else:
        if title:
            folder.title = title
        if media_count is not None:
            folder.media_count = media_count

    return folder


def _extract_video_info(media: dict) -> tuple[str, str, Optional[int]]:
    """抽取视频关键信息"""
    bvid = media.get("bvid") or media.get("bv_id")
    title = media.get("title", bvid)
    cid = None
    ugc = media.get("ugc") or {}
    if ugc.get("first_cid"):
        cid = ugc.get("first_cid")
    else:
        cid = media.get("cid") or media.get("id")
    return bvid, title, cid


async def _upsert_collection(db: AsyncSession, media_id: int, bvid: str, meta: dict) -> None:
    """写入或更新 collection 视频元数据（key: media_id + bvid）"""
    result = await db.execute(
        select(Collection).where(Collection.media_id == media_id, Collection.bvid == bvid)
    )
    row = result.scalar_one_or_none()

    if row is None:
        row = Collection(
            media_id=media_id,
            bvid=bvid,
            title=meta.get("title") or bvid,
            description=meta.get("intro"),
            owner_name=meta.get("owner_name"),
            owner_mid=meta.get("owner_mid"),
            duration=meta.get("duration"),
            cover=meta.get("cover"),
        )
        db.add(row)
        return

    if meta.get("title"):
        row.title = meta["title"]
    if meta.get("intro") is not None:
        row.description = meta["intro"]
    if meta.get("owner_name") is not None:
        row.owner_name = meta["owner_name"]
    if meta.get("owner_mid") is not None:
        row.owner_mid = meta["owner_mid"]
    if meta.get("duration") is not None:
        row.duration = meta["duration"]
    if meta.get("cover") is not None:
        row.cover = meta["cover"]


async def _sync_folder(
    db: AsyncSession,
    bili: BilibiliService,
    rag: RAGService,
    content_fetcher: ContentFetcher,
    uid: int,
    folder_id: int,
    exclude_bvids: Optional[set[str]] = None,
    progress_callback: Optional[Callable[[str], None]] = None,
) -> dict:
    """同步单个收藏夹到向量库"""
    info = {}
    try:
        info_result = await bili.get_favorite_content(folder_id, pn=1, ps=1)
        info = info_result.get("info", {})
    except Exception as e:
        logger.warning(f"获取收藏夹信息失败 [{folder_id}]: {e}")

    videos = await bili.get_all_favorite_videos(folder_id)
    total_in_folder = info.get("media_count", len(videos))

    # 保护：接口异常返回空列表时，避免误删
    if not videos:
        if total_in_folder and total_in_folder > 0:
            logger.warning(f"[{folder_id}] 收藏夹返回空列表，跳过删除逻辑")
            existing_count = await db.scalar(
                select(func.count()).where(Collection.media_id == folder_id)
            )
            return {
                "folder_id": folder_id,
                "total": total_in_folder,
                "added": 0,
                "removed": 0,
                "indexed": existing_count or 0,
                "message": "本次同步异常：空列表，已跳过",
                "last_sync_at": datetime.now(timezone.utc),
            }

    video_map = {}
    skipped_invalid = 0
    for media in videos:
        bvid, title, cid = _extract_video_info(media)
        if not bvid:
            continue
        if exclude_bvids and bvid in exclude_bvids:
            continue
        
        # 过滤失效视频（被删除、下架等）
        # attr 字段: 0=正常, 9=已失效, 1=私密等
        attr = media.get("attr", 0)
        if attr == 9 or title in ["已失效视频", "已删除视频"]:
            skipped_invalid += 1
            logger.debug(f"跳过失效视频: {bvid} - {title}")
            continue
        
        owner = media.get("upper") or {}
        video_map[bvid] = {
            "title": title,
            "cid": cid,
            "intro": media.get("intro"),
            "cover": media.get("cover"),
            "duration": media.get("duration"),
            "owner_name": owner.get("name"),
            "owner_mid": owner.get("mid"),
        }
    
    if skipped_invalid > 0:
        logger.info(f"[{folder_id}] 过滤了 {skipped_invalid} 个失效视频")

    # 以有效视频数作为统计口径（过滤失效视频）
    valid_count = len(video_map)
    current_bvids = set(video_map.keys())

    folder = await _get_or_create_folder(
        db,
        uid=uid,
        media_id=folder_id,
        title=info.get("title"),
        media_count=valid_count,
    )

    # 查 collection 中该 media_id 已有的 bvid
    existing_rows = await db.execute(
        select(Collection.bvid).where(Collection.media_id == folder_id)
    )
    existing_bvids = {row[0] for row in existing_rows.fetchall()}

    added = current_bvids - existing_bvids
    removed = existing_bvids - current_bvids

    # 写入 collection 元数据
    for bvid, meta in video_map.items():
        await _upsert_collection(db, folder_id, bvid, meta)

    source_priority = {
        ContentSource.BASIC_INFO.value: 1,
        ContentSource.AI_SUMMARY.value: 2,
        ContentSource.SUBTITLE.value: 3,
        ContentSource.ASR.value: 4,
    }

    def _is_better_source(new_source: str, old_source: Optional[str]) -> bool:
        return source_priority.get(new_source, 0) > source_priority.get(old_source or "", 0)

    async def _get_content_text(bvid: str, cid: int, title: str, content_fetcher, meta: dict) -> tuple[str, str]:
        """Get ASR text for a video. Tries MongoDB → fetch → save to MongoDB.
        Returns (text, source).
        Full text lives in MongoDB only, never written to MySQL.
        """
        from app.infra.mongo import is_enabled as _mongo_ok
        from app.repository.mongo_asr_repository import get_latest, save_asr
        # 1. Try MongoDB (shared across users — deduplication)
        if _mongo_ok():
            try:
                doc = await get_latest(bvid, cid)
                if doc and doc.get("content") and len(doc["content"].strip()) >= 50:
                    logger.info(f"[{bvid}] content found in MongoDB (shared)")
                    return doc["content"], doc.get("content_source", "asr")
            except Exception as e:
                logger.warning(f"[{bvid}] MongoDB read failed: {e}")

        # 2. Fetch from Bilibili (ASR / subtitle / AI summary)
        content = await content_fetcher.fetch_content(bvid, cid=cid, title=title)
        text = (content.content or "").strip() if content else ""
        source = content.source.value if content else ContentSource.BASIC_INFO.value

        if not text or len(text) < 50:
            logger.warning(f"[{bvid}] fetched content too short ({len(text)} chars)")
            return text, source

        # 3. Save to MongoDB (shared — future users skip ASR)
        if _mongo_ok():
            try:
                await save_asr(
                    video_id=bv_to_av(bvid),
                    bvid=bvid, cid=cid or 0, page_index=0,
                    page_title=meta.get("title", title),
                    content=text, content_source=source,
                )
                logger.info(f"[{bvid}] content saved to MongoDB (shared)")
            except Exception as e:
                logger.warning(f"[{bvid}] MongoDB save failed: {e}")

        return text, source

    # ── Per-page vectorization ──
    # Three-layer ingestion: collection (folder) → video (bvid) → page (cid).
    # For each bvid we materialize all pages into the `video` table, then
    # serially feed every still-pending page into vector_page_service so it
    # runs through ASR + vectorization with proper task tracking.
    from app.services.video.service import VideoService
    from app.services.vector_page_service import VectorPageService

    video_service = VideoService()
    page_tracker = TaskTracker()
    vector_service = VectorPageService(page_tracker, rag=rag)

    # Walk every video in this folder so newly-added pages of previously-known
    # bvids also get picked up. Already-done pages will be skipped cheaply.
    targets = list(current_bvids)
    total_targets = len(targets)
    processed_targets = 0
    if progress_callback:
        progress_callback("准备处理", processed_targets, total_targets)

    failed_pages: list[tuple[str, int]] = []

    for bvid in targets:
        meta = video_map[bvid]

        try:
            # 1) Materialize all pages of this bvid into `video` table
            pages_info = await video_service.list_pages_by_bvid(bvid, bili, db)
            pages = pages_info.get("pages") or []

            # 2) Filter pages that still need vectorization
            todo = [p for p in pages if p.get("is_vectorized") != "done"]
            if not todo:
                logger.info(
                    f"[{bvid}] all {len(pages)} page(s) already vectorized, skipping"
                )
            else:
                logger.info(
                    f"[{bvid}] queue {len(todo)}/{len(pages)} page(s) for vectorization"
                )
                for p_idx, p in enumerate(todo):
                    cid = p["cid"]
                    page_index = p["page_index"]
                    page_title = p.get("page_title") or f"P{page_index + 1}"

                    vec_task_id = await page_tracker.create(
                        uid=uid,
                        task_type="vec_page",
                        target={
                            "bvid": bvid,
                            "cid": cid,
                            "page_index": page_index,
                            "page_title": page_title,
                        },
                    )
                    try:
                        await vector_service.process_page_vectorization(
                            task_id=vec_task_id,
                            bvid=bvid,
                            cid=cid,
                            page_index=page_index,
                            page_title=page_title,
                        )
                    except Exception as page_err:
                        # Failed page is already marked is_vectorized=failed in
                        # vector_page_service; just log and move on.
                        logger.warning(
                            f"[{bvid}] page cid={cid} idx={page_index} failed: {page_err}"
                        )
                        failed_pages.append((bvid, cid))

                    # Inter-page pause: 1-3s human pacing per the spec.
                    if p_idx < len(todo) - 1:
                        await _human_pause(1.0, 3.0)

        except Exception as e:
            logger.warning(f"[{bvid}] enumerate/process pages failed: {e}")
            failed_pages.append((bvid, -1))

        processed_targets += 1
        if progress_callback:
            progress_callback(meta["title"], processed_targets, total_targets)

        # Inter-video pause to keep load steady across the whole folder.
        if processed_targets < total_targets:
            await _human_pause(1.5, 4.0)

    if failed_pages:
        logger.warning(
            f"[{folder_id}] {len(failed_pages)} page(s) failed during vectorization"
        )

    # 删除已移除的视频
    if removed:
        for bvid in removed:
            other_count = await db.scalar(
                select(func.count())
                .select_from(Collection)
                .where(Collection.bvid == bvid, Collection.media_id != folder_id)
            )
            if other_count == 0:
                try:
                    rag.delete_video(bvid)
                except Exception as e:
                    logger.warning(f"删除向量失败 [{bvid}]: {e}")

        await db.execute(
            delete(Collection).where(
                Collection.media_id == folder_id,
                Collection.bvid.in_(removed),
            )
        )

    folder.last_sync_at = datetime.now(timezone.utc)
    await db.commit()

    # 清除 Redis 缓存（folder_status + vec_status）
    try:
        from app.infra.redis import client as _redis, k as _rk
        if _redis:
            await _redis.delete(_rk("folder_status", str(uid)))
    except Exception:
        pass

    indexed_count = await db.scalar(
        select(func.count(func.distinct(Collection.bvid)))
        .select_from(Collection)
        .where(Collection.media_id == folder_id)
    )

    return {
        "folder_id": folder_id,
        "total": valid_count,
        "added": len(added),
        "removed": len(removed),
        "indexed": indexed_count or 0,
        "message": "同步完成",
        "last_sync_at": folder.last_sync_at,
    }


@router.get("/stats")
async def get_knowledge_stats():
    """获取知识库统计信息"""
    try:
        rag = get_rag_service()
        stats = rag.get_collection_stats()
        return stats
    except Exception as e:
        logger.exception("Failed to get knowledge stats")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/folders/status", response_model=List[FolderStatus])
async def get_folder_status(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """获取收藏夹入库状态 — 按「所有分P均已向量化」的视频数统计"""

    # 0. 尝试 Redis 缓存（30s TTL）
    try:
        from app.infra.redis import client as _redis, k as _rk, jget as _rjget, jset as _rjset
        cache_key = _rk("folder_status", str(uid))
        if _redis:
            cached = await _rjget(cache_key)
            if cached:
                return [FolderStatus(**item) for item in cached]
    except Exception:
        pass

    # 1. 查该用户所有有效收藏夹
    folders_result = await db.execute(
        select(
            FavoriteFolder.media_id,
            FavoriteFolder.media_count,
            FavoriteFolder.last_sync_at,
        ).where(
            FavoriteFolder.uid == uid,
            FavoriteFolder.deleted_at.is_(None),
        )
    )
    folders = folders_result.all()
    if not folders:
        return []

    # {media_id: (media_count, last_sync_at)}
    folder_meta = {
        row.media_id: (row.media_count, row.last_sync_at)
        for row in folders
    }
    media_ids = list(folder_meta.keys())

    # 2. 统计每个收藏夹中「所有分P均已向量化」的视频数（bvid 级别）
    incomplete_sub = (
        select(Video.bvid)
        .where(
            or_(
                Video.is_vectorized != "done",
                Video.is_vectorized.is_(None),
            )
        )
        .subquery()
    )
    counts_result = await db.execute(
        select(
            Collection.media_id,
            func.count(func.distinct(Video.bvid)),
        ).select_from(Collection).join(
            Video,
            Video.bvid == Collection.bvid,
        ).where(
            Collection.media_id.in_(media_ids),
            ~Video.bvid.in_(select(incomplete_sub.c.bvid)),
        ).group_by(Collection.media_id)
    )
    count_map = {row[0]: row[1] for row in counts_result.all()}

    # 3. 组装返回
    result = [
        FolderStatus(
            media_id=media_id,
            indexed_count=count_map.get(media_id, 0),
            media_count=meta[0],
            last_sync_at=meta[1],
        )
        for media_id, meta in folder_meta.items()
    ]

    # 4. 写入 Redis 缓存（30s TTL）
    try:
        if _redis:
            await _rjset(cache_key, [r.model_dump() for r in result], ex=30)
    except Exception:
        pass

    return result


class VectorizedPageItem(BaseModel):
    """向量化分P项"""
    bvid: str
    cid: int
    page_index: int
    page_title: Optional[str] = None
    video_title: Optional[str] = None
    vector_chunk_count: int = 0
    vectorized_at: Optional[datetime] = None


@router.get("/pages/vectorized", response_model=List[VectorizedPageItem])
async def get_vectorized_pages(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Get vectorized pages for the current user (uid-scoped)."""
    # 1. Get all media_ids for this user
    folders_result = await db.execute(
        select(FavoriteFolder.media_id)
        .where(FavoriteFolder.uid == uid, FavoriteFolder.deleted_at.is_(None))
    )
    media_ids = [row[0] for row in folders_result.all()]
    if not media_ids:
        return []

    # 2. Get all bvids belonging to user's collections
    bvids_result = await db.execute(
        select(Collection.bvid)
        .where(Collection.media_id.in_(media_ids))
    )
    bvids = list(set(row[0] for row in bvids_result.all() if row[0]))
    if not bvids:
        return []

    # 3. Get vectorized pages from video table
    pages_result = await db.execute(
        select(Video)
        .where(Video.bvid.in_(bvids), Video.is_vectorized == "done")
        .order_by(Video.bvid, Video.page_index)
    )
    pages = pages_result.scalars().all()

    # 4. Resolve video titles from collection
    bvid_set = {p.bvid for p in pages}
    titles_result = await db.execute(
        select(Collection.bvid, Collection.title)
        .where(Collection.bvid.in_(bvid_set))
    )
    title_map = {row[0]: row[1] for row in titles_result.all()}

    return [
        VectorizedPageItem(
            bvid=p.bvid,
            cid=p.cid,
            page_index=p.page_index,
            page_title=p.page_title,
            video_title=title_map.get(p.bvid, ""),
            vector_chunk_count=p.vector_chunk_count or 0,
            vectorized_at=p.vectorized_at,
        )
        for p in pages
    ]


@router.post("/folders/sync", response_model=List[SyncResult])
async def sync_folders(
    request: SyncRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """同步收藏夹到向量库"""
    bili, bili_mid = await _get_bili_cookies_by_uid(uid, db)

    rag = get_rag_service()
    asr_service = ASRService()
    content_fetcher = ContentFetcher(bili, asr_service)

    try:
        folder_ids = request.folder_ids or []
        if not folder_ids:
            folders = await bili.get_user_favorites(mid=bili_mid)
            folder_ids = [folder.get("id") for folder in folders if folder.get("id")]

        results: List[SyncResult] = []
        for folder_id in folder_ids:
            try:
                result = await _sync_folder(
                    db,
                    bili,
                    rag,
                    content_fetcher,
                    uid,
                    folder_id,
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
    background_tasks: BackgroundTasks,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """构建知识库（后台任务，写入 async_tasks 表）。

    全局单例：同一进程同一时刻只允许一个 build 任务在跑。重复点击直接
    返回当前活跃的 task_id，而不是再起一个新的——避免对 B站 CDN 的并发
    请求触发限流。
    """
    global _active_build_task_id, _active_build_uid

    async with _active_build_lock:
        if _active_build_task_id is not None:
            logger.info(
                f"[build] reuse active task_id={_active_build_task_id} "
                f"uid={_active_build_uid} (requested by uid={uid})"
            )
            return {
                "task_id": _active_build_task_id,
                "message": "已有构建任务在运行，复用该任务",
                "reused": True,
            }

        bili, _bili_mid = await _get_bili_cookies_by_uid(uid, db)
        sessdata = bili.sessdata

        tracker = TaskTracker()
        task_id = await tracker.create(
            uid=uid,
            task_type="build",
            target={"folder_ids": request.folder_ids},
        )
        # Legacy in-memory compat (existing polling endpoint still reads build_tasks)
        build_tasks[task_id] = build_tasks.get(task_id) or {
            "status": "pending", "progress": 0, "current_step": "初始化中...",
            "total_videos": 0, "processed_videos": 0, "message": "",
        }

        # Mark this task as the active singleton BEFORE scheduling, so a
        # second click that arrives while we're still in this function still
        # sees the lock as taken.
        _active_build_task_id = task_id
        _active_build_uid = uid

    background_tasks.add_task(
        _build_knowledge_base_task,
        task_id,
        uid,
        sessdata,
        request.folder_ids,
        request.exclude_bvids or [],
    )

    return {"task_id": task_id, "message": "构建任务已启动", "reused": False}


@router.get("/build/active")
async def get_active_build_task(uid: int = Depends(get_current_uid)):
    """查询当前是否有活跃的 build 任务（前端用来禁用按钮 / 复用 task_id）。"""
    if _active_build_task_id is None:
        return {"active": False, "task_id": None, "uid": None}
    return {
        "active": True,
        "task_id": _active_build_task_id,
        "uid": _active_build_uid,
        "is_yours": _active_build_uid == uid,
    }


async def _build_knowledge_base_task(
    task_id: str,
    uid: int,
    sessdata: str,
    folder_ids: List[int],
    exclude_bvids: List[str],
):
    """后台构建任务 — 通过 TaskTracker 写入 async_tasks 表，完成后广播 WebSocket。"""
    from app.services.async_task.tracker import TaskTracker
    global _active_build_task_id, _active_build_uid

    # Mutable cursor of "where are we right now". Updated as we move between
    # folders / videos so every _notify() call carries the same context.
    cursor: dict = {
        "folder_index": 0,
        "total_folders": 0,
        "folder_id": None,
        "folder_title": None,
        "video_index": 0,
        "total_videos_in_folder": 0,
        "current_video_title": None,
    }

    def _notify(status: str, **kwargs) -> None:
        """Update legacy state + broadcast to WebSocket clients.

        Always includes the current folder/video cursor so the frontend can
        render "收藏夹 A: 3/12 — 正在处理《XXX》" without extra round trips.
        """
        # legacy_state only knows a small set of fields; pass them explicitly.
        legacy_kwargs = {
            k: v for k, v in kwargs.items()
            if k in {"progress", "processed", "total_videos", "message"}
        }
        if "current_step" in kwargs:
            legacy_kwargs["step"] = kwargs["current_step"]
        legacy_state(task_id, status, **legacy_kwargs)
        try:
            from app.routers.tasks_ws import broadcast_task_update
            import asyncio
            task_info = {
                "task_id": task_id, "task_type": "build", "uid": uid,
                "status": status,
                **cursor,
                **kwargs,
            }
            asyncio.ensure_future(broadcast_task_update(uid, task_info))
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
                await tracker.complete(task_id, {"message": "没有需要处理的收藏夹"})
                _notify("done", progress=100, current_step="完成")
                return

            total_videos_processed = 0
            total_added = 0
            total_removed = 0

            cursor["total_folders"] = total_folders

            async with get_db_context() as db:
                for idx, folder_id in enumerate(folder_ids, start=1):
                    folder_progress = int((idx / total_folders) * 100)

                    # Resolve folder title (best-effort) so the broadcast carries
                    # human-readable context, not just a numeric id.
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

                    cursor.update({
                        "folder_index": idx,
                        "folder_id": folder_id,
                        "folder_title": folder_title,
                        "video_index": 0,
                        "total_videos_in_folder": 0,
                        "current_video_title": None,
                    })

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

                    def progress_cb(title: str, count: int = 0, total: int = 0):
                        cursor.update({
                            "video_index": count,
                            "total_videos_in_folder": total,
                            "current_video_title": title,
                        })
                        legacy_state(
                            task_id, "running",
                            step=f"处理: {title}",
                            processed=count, total_videos=total,
                        )
                        _notify(
                            "running",
                            progress=folder_progress,
                            current_step=f"{folder_label} {count}/{total}：{title}",
                        )

                    result = await _sync_folder(
                        db, bili, rag, content_fetcher,
                        uid, folder_id,
                        exclude_bvids=set(exclude_bvids),
                        progress_callback=progress_cb,
                    )

                    total_videos_processed += result.get("added", 0) + result.get("indexed", 0)
                    total_added += result["added"]
                    total_removed += result["removed"]

                    # Human-pace pause between folders so we don't hammer the API.
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
            cursor.update({
                "video_index": 0,
                "total_videos_in_folder": 0,
                "current_video_title": None,
            })
            _notify("done", progress=100,
                    current_step="完成",
                    message=f"同步完成：新增 {total_added}，移除 {total_removed}")

            # 清除 Redis 缓存
            try:
                from app.infra.redis import client as _redis2, k as _rk2
                if _redis2:
                    await _redis2.delete(_rk2("folder_status", str(uid)))
            except Exception:
                pass

            logger.info(f"知识库构建完成: 新增 {total_added}，移除 {total_removed}")
        finally:
            await bili.close()

    except Exception as e:
        logger.exception("Build task failed")
        await tracker.fail(task_id, str(e))
        _notify("failed", message=str(e))
    finally:
        # Release the singleton so a new build can be scheduled.
        async with _active_build_lock:
            if _active_build_task_id == task_id:
                _active_build_task_id = None
                _active_build_uid = None
                logger.info(f"[build] released singleton task_id={task_id}")


def legacy_state(task_id: str, status: str, step: str = "",
                 progress: int = 0, processed: int = 0, total_videos: int = 0,
                 message: str = "") -> None:
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


@router.get("/build/status/{task_id}", response_model=BuildStatus)
async def get_build_status(task_id: str):
    """获取构建任务状态 — async_tasks 表优先，build_tasks 内存兜底"""
    # 1. Try async_tasks table (persisted)
    try:
        from app.database import get_db_context
        from sqlalchemy import select
        from app.models import AsyncTask

        async with get_db_context() as db:
            result = await db.execute(
                select(AsyncTask).where(AsyncTask.task_id == task_id)
            )
            row = result.scalar_one_or_none()
            if row:
                current_step = ""
                if row.steps:
                    last = row.steps[-1] if row.steps else {}
                    current_step = last.get("name", "")
                # `total_videos` is a count, not the folder list itself.
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
async def clear_knowledge_base():
    """清空知识库"""
    try:
        rag = get_rag_service()
        rag.clear_collection()
        return {"message": "知识库已清空"}
    except Exception as e:
        logger.exception("Failed to clear knowledge base")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/video/{bvid}")
async def delete_video_from_knowledge(bvid: str):
    """从知识库中删除指定视频"""
    try:
        rag = get_rag_service()
        rag.delete_video(bvid)
        return {"message": f"已删除视频 {bvid}"}
    except Exception as e:
        logger.exception("Failed to delete video")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 视频分P旁路缓存 ====================

PAGES_CACHE_KEY = "video:pages:{bvid}"
PAGES_CACHE_TTL = 86400  # 24小时


@router.get("/video/{bvid}/pages", response_model=VideosResponse, deprecated=True)
async def get_video(
    bvid: str,
    cache=Depends(cache_dependency_singleton()),
):
    """
    获取视频全部分P信息（旁路缓存策略）

    缓存未命中 → 调 B站 API → 写入缓存（TTL=24h）→ 返回
    缓存命中 → 直接返回
    """
    # 1. 校验 bvid 格式
    if not re.match(r"^[Bb][Vv][a-zA-Z0-9]{10}$", bvid):
        raise HTTPException(status_code=400, detail="Invalid bvid format")

    cache_key = PAGES_CACHE_KEY.format(bvid=bvid)

    # 2. 查缓存
    cached = cache.get(cache_key)
    if cached:
        return VideosResponse(**cached)

    # 3. 缓存未命中，调 B站 API
    bili = BilibiliService()
    try:
        video_info = await bili.get_video_info(bvid)
    except Exception as e:
        logger.exception("[PAGES] Bilibili API call failed bvid={}", bvid)
        raise HTTPException(status_code=502, detail=f"B站 API 调用失败: {e}")
    finally:
        await bili.close()

    pages_raw = video_info.get("pages") or []
    page_count = len(pages_raw) if pages_raw else 1

    # 4. 构建响应数据
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

    # 5. 写入缓存（降级：缓存失败仍返回数据）
    try:
        cache.set(cache_key, data)
    except Exception as e:
        logger.warning(f"[PAGES] 缓存写入失败 bvid={bvid}: {e}")

    return VideosResponse(**data)

