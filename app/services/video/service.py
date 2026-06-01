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

from app.services.bilibili import BilibiliService
from app.repository.video_repository import get_video_repository, VideoRepository
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
        """List all pages (cids) for a bvid with cross-store consistency check.

        Page metadata (titles, cids) is cached. Vector/MongoDB verification
        runs on every call to auto-heal MySQL after DB migrations.
        """
        ns = _video_ns()

        async def _fetch_pages():
            """Fetch page metadata from DB or Bilibili API (cached)."""
            count = await self._repo.count_by_bvid(bvid, db)
            if count == 0:
                logger.info(f"[VideoService] fetching pages for bvid={bvid}")
                video_info = await bili.get_video_info(bvid)
                pages_raw = video_info.get("pages") or []

                if pages_raw:
                    pages = [
                        {"cid": p["cid"], "page_index": p.get("page", 1) - 1,
                         "page_title": p.get("part", ""), "duration": p.get("duration", 0)}
                        for p in pages_raw
                    ]
                    await self._repo.upsert_pages(bvid, pages, db)
                    logger.info(f"[VideoService] stored {len(pages)} pages for bvid={bvid}")
                else:
                    cid = video_info.get("cid") or 0
                    pages = [{"cid": cid, "page_index": 0,
                              "page_title": video_info.get("title", ""),
                              "duration": video_info.get("duration", 0)}]
                    await self._repo.upsert_pages(bvid, pages, db)

            return await self._repo.list_by_bvid(bvid, db)

        # Cached: ensure pages exist in DB (fetches from Bilibili API if needed)
        await ns.get_or_fetch(bvid, lambda: _fetch_pages())

        # Always re-query from DB with current session — NEVER reuse cached ORM objects
        # (cached objects are detached from the current session, commits would be no-ops)
        rows = await self._repo.list_by_bvid(bvid, db)

        # Cross-store verification: auto-heal MySQL when external data is missing
        from app.services.rag import get_rag_service as _get_rag
        rag = _get_rag()
        need_commit = False
        verified_pages = []

        for r in rows:
            fixed_vectorized = r.is_vectorized
            actual_count = 0

            if r.is_vectorized == "done":
                actual_count = rag.get_page_vector_count(bvid, r.page_index)
                if actual_count == 0:
                    r.is_vectorized = "failed"
                    r.vector_error = "Vector data lost after DB migration"
                    fixed_vectorized = "failed"
                    need_commit = True
                    logger.warning(f"[VideoService] bvid={bvid} cid={r.cid} marked failed: vector count=0")

            if r.is_processed:
                from app.infra.mongo import is_enabled as _mongo_ok
                from app.repository.mongo_asr_repository import get_latest
                if _mongo_ok():
                    doc = await get_latest(bvid, r.cid)
                    if not doc or not doc.get("content") or len(doc["content"].strip()) < 50:
                        r.is_processed = False
                        need_commit = True
                        logger.warning(f"[VideoService] bvid={bvid} cid={r.cid} marked unprocessed: no content in MongoDB")

            verified_pages.append({
                "cid": r.cid, "page_index": r.page_index,
                "page_title": r.page_title,
                "is_processed": r.is_processed,
                "is_vectorized": fixed_vectorized,
                "vector_chunk_count": actual_count if actual_count > 0 else (r.vector_chunk_count if fixed_vectorized == "done" else 0),
            })

        if need_commit:
            await db.commit()
            logger.info(f"[VideoService] committed auto-heal for bvid={bvid}")

        return {
            "bvid": bvid,
            "pages": verified_pages,
            "page_count": len(rows),
            "is_stored": True,
        }
