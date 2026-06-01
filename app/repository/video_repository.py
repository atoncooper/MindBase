"""
Video (video_pages) CRUD repository — pages identified by bvid + cid.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Video


class VideoRepository:
    """Persistence for video pages (one row per cid)."""

    async def list_by_bvid(self, bvid: str, db: AsyncSession) -> list[Video]:
        result = await db.execute(
            select(Video)
            .where(Video.bvid == bvid)
            .order_by(Video.page_index)
        )
        return list(result.scalars().all())

    async def count_by_bvid(self, bvid: str, db: AsyncSession) -> int:
        result = await db.execute(
            select(func.count()).where(Video.bvid == bvid)
        )
        return result.scalar() or 0

    async def upsert_pages(
        self,
        bvid: str,
        pages: list[dict],   # [{"cid": int, "page_index": int, "page_title": str, "duration": int}, ...]
        db: AsyncSession,
    ) -> int:
        """Replace all pages for a bvid; returns count inserted."""
        from sqlalchemy import delete as sa_delete

        await db.execute(sa_delete(Video).where(Video.bvid == bvid))
        await db.commit()

        datetime.utcnow()
        for p in pages:
            db.add(Video(
                bvid=bvid,
                cid=p["cid"],
                page_index=p["page_index"],
                page_title=p.get("page_title"),
                is_processed=False,
                version=1,
                is_vectorized="pending",
            ))
        await db.commit()
        return len(pages)

    async def get_by_bvid_cid(self, bvid: str, cid: int, db: AsyncSession) -> Optional[Video]:
        result = await db.execute(
            select(Video).where(Video.bvid == bvid, Video.cid == cid)
        )
        return result.scalar_one_or_none()


# Module-level singleton
_repo: Optional[VideoRepository] = None


def get_video_repository() -> VideoRepository:
    global _repo
    if _repo is None:
        _repo = VideoRepository()
    return _repo
