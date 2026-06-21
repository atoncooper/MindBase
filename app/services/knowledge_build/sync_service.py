"""Knowledge sync service — synchronize a single Bilibili favorite folder.

Absorbs ``_sync_folder`` (and its helpers ``_extract_video_info``,
``_upsert_collection``, ``_get_or_create_folder``, ``_human_pause``)
from ``app/routers/knowledge.py``.

Per CLAUDE.md §6, this is service-layer code: it orchestrates B站 API,
MongoDB, MySQL, and the vector pipeline. The router calls into this;
this module never touches HTTP.
"""
from __future__ import annotations

import asyncio
import random
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from loguru import logger
from sqlalchemy import select, func, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import FavoriteFolder, Collection
from app.response.knowledge import ContentSource
from app.services.bilibili import BilibiliService
from app.services.content_fetcher import ContentFetcher
from app.services.rag import RAGService
from app.utils.bvid import bv_to_av


async def _human_pause(min_s: float, max_s: float) -> None:
    """Random sleep between min_s and max_s seconds — mimics human pacing."""
    await asyncio.sleep(random.uniform(min_s, max_s))


def _extract_video_info(media: dict) -> tuple[str, str, Optional[int]]:
    """Extract (bvid, title, cid) from a B站 media dict."""
    bvid = media.get("bvid") or media.get("bv_id")
    title = media.get("title", bvid)
    cid: Optional[int] = None
    ugc = media.get("ugc") or {}
    if ugc.get("first_cid"):
        cid = ugc.get("first_cid")
    else:
        cid = media.get("cid") or media.get("id")
    return bvid, title, cid


async def _get_or_create_folder(
    db: AsyncSession,
    uid: int,
    media_id: int,
    title: Optional[str] = None,
    media_count: Optional[int] = None,
) -> FavoriteFolder:
    """Get or create a FavoriteFolder row scoped by uid."""
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


async def _upsert_collection(
    db: AsyncSession, media_id: int, bvid: str, meta: dict
) -> None:
    """Insert or update a Collection row keyed by (media_id, bvid)."""
    result = await db.execute(
        select(Collection).where(
            Collection.media_id == media_id, Collection.bvid == bvid
        )
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


class KnowledgeSyncService:
    """Synchronize a single favorite folder to the vector store."""

    async def sync_folder(
        self,
        db: AsyncSession,
        bili: BilibiliService,
        rag: RAGService,
        content_fetcher: ContentFetcher,
        uid: int,
        folder_id: int,
        exclude_bvids: Optional[set[str]] = None,
        progress_callback: Optional[Callable[[str, int, int], None]] = None,
    ) -> dict:
        """Sync a single folder; returns a result dict.

        Safety: if B站 returns an empty list while media_count > 0 (a known
        throttle / network symptom), we DO NOT delete existing rows.
        """
        info: dict = {}
        try:
            info_result = await bili.get_favorite_content(folder_id, pn=1, ps=1)
            info = info_result.get("info", {})
        except Exception as e:
            logger.warning(f"获取收藏夹信息失败 [{folder_id}]: {e}")

        videos = await bili.get_all_favorite_videos(folder_id)
        total_in_folder = info.get("media_count", len(videos))

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

        video_map: dict[str, dict] = {}
        skipped_invalid = 0
        for media in videos or []:
            bvid, title, cid = _extract_video_info(media)
            if not bvid:
                continue
            if exclude_bvids and bvid in exclude_bvids:
                continue

            # attr: 0=normal, 9=invalid, 1=private, etc.
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

        valid_count = len(video_map)
        current_bvids = set(video_map.keys())

        folder = await _get_or_create_folder(
            db,
            uid=uid,
            media_id=folder_id,
            title=info.get("title"),
            media_count=valid_count,
        )

        existing_rows = await db.execute(
            select(Collection.bvid).where(Collection.media_id == folder_id)
        )
        existing_bvids = {row[0] for row in existing_rows.fetchall()}

        added = current_bvids - existing_bvids
        removed = existing_bvids - current_bvids

        for bvid, meta in video_map.items():
            await _upsert_collection(db, folder_id, bvid, meta)

        # ── Per-page vectorization ──
        from app.services.video.service import VideoService
        from app.services.vector_page_service import VectorPageService
        from app.services.async_task.tracker import TaskTracker

        video_service = VideoService()
        page_tracker = TaskTracker()
        vector_service = VectorPageService(page_tracker, rag=rag)

        targets = list(current_bvids)
        total_targets = len(targets)
        processed_targets = 0
        if progress_callback:
            progress_callback("准备处理", processed_targets, total_targets)

        failed_pages: list[tuple[str, int]] = []

        for bvid in targets:
            meta = video_map[bvid]
            try:
                pages_info = await video_service.list_pages_by_bvid(bvid, bili, db)
                pages = pages_info.get("pages") or []
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
                            logger.warning(
                                f"[{bvid}] page cid={cid} idx={page_index} failed: {page_err}"
                            )
                            failed_pages.append((bvid, cid))

                        if p_idx < len(todo) - 1:
                            await _human_pause(1.0, 3.0)
            except Exception as e:
                logger.warning(f"[{bvid}] enumerate/process pages failed: {e}")
                failed_pages.append((bvid, -1))

            processed_targets += 1
            if progress_callback:
                progress_callback(meta["title"], processed_targets, total_targets)

            if processed_targets < total_targets:
                await _human_pause(1.5, 4.0)

        if failed_pages:
            logger.warning(
                f"[{folder_id}] {len(failed_pages)} page(s) failed during vectorization"
            )

        # Delete removed videos (only if not referenced by other folders)
        if removed:
            for bvid in removed:
                other_count = await db.scalar(
                    select(func.count())
                    .select_from(Collection)
                    .where(
                        Collection.bvid == bvid, Collection.media_id != folder_id
                    )
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

        # Invalidate Redis cache for folder_status
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
