"""
VideoService — page-level business logic (bvid → cids).

Responsibilities:
  - Fetch video pages from Bilibili API (get_video_info → pages)
  - Upsert into video table (keyed by bvid + cid)
  - Serve local DB queries

Not responsible for:
  - ASR processing (handled by asr_page_service)
  - Vectorization (handled by vector_page_service)
"""

from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models import Video
from app.services.bilibili import BilibiliService
from app.repository.video_repository import get_video_repository, VideoRepository
from app.utils.bvid import bv_to_av
from app.infra.cache import cache_manager

_VIDEO_TTL = 300   # 5 min


def _video_ns():
    return cache_manager.namespace("video_pages", ttl=_VIDEO_TTL)


async def _invalidate_video_pages(bvid: str) -> None:
    await _video_ns().delete(bvid)


class VideoService:
    """Video pages v2 business logic."""

    def __init__(self, repo: Optional[VideoRepository] = None):
        self._repo = repo or get_video_repository()

    async def list_pages_by_bvid(
        self,
        bvid: str,
        bili: BilibiliService,
        db: AsyncSession,
    ) -> dict:
        """List all pages (cids) for a bvid (cached, single-flight).

        Reads from cache first → DB → Bilibili API if empty.
        """
        ns = _video_ns()

        async def _fetch():
            count = await self._repo.count_by_bvid(bvid, db)
            if count == 0:
                logger.info(f"[VideoService] fetching pages for bvid={bvid}")
                video_info = await bili.get_video_info(bvid)
                pages_raw = video_info.get("pages") or []
                video_id = bv_to_av(bvid)

                if pages_raw:
                    pages = [
                        {
                            "cid": p["cid"],
                            "page_index": p.get("page", 1) - 1,
                            "page_title": p.get("part", ""),
                            "duration": p.get("duration", 0),
                        }
                        for p in pages_raw
                    ]
                    await self._repo.upsert_pages(bvid, video_id, pages, db)
                    logger.info(f"[VideoService] stored {len(pages)} pages for bvid={bvid}")
                else:
                    cid = video_info.get("cid") or 0
                    pages = [{
                        "cid": cid, "page_index": 0,
                        "page_title": "", "duration": video_info.get("duration", 0),
                    }]
                    await self._repo.upsert_pages(bvid, video_id, pages, db)

            rows = await self._repo.list_by_bvid(bvid, db)
            return {
                "bvid": bvid,
                "pages": [
                    {
                        "cid": r.cid, "page_index": r.page_index,
                        "page_title": r.page_title,
                        "is_processed": r.is_processed,
                        "is_vectorized": r.is_vectorized,
                        "vector_chunk_count": r.vector_chunk_count,
                    }
                    for r in rows
                ],
                "page_count": len(rows),
                "is_stored": True,
            }

        return await ns.get_or_fetch(bvid, _fetch)
