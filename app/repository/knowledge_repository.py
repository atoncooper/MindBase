"""Knowledge query repository — MySQL read access for knowledge endpoints.

Absorbs the inline SQL/ORM that previously lived in ``app/routers/knowledge.py``
for ``get_folder_status``, ``get_vectorized_pages``, ``get_build_status``,
and the bvid ownership check in ``delete_video_from_knowledge``.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import select, func, or_, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import FavoriteFolder, Collection, Video, AsyncTask


class KnowledgeRepository:
    """Read-side data access for the knowledge module."""

    # ── Folder status ──────────────────────────────────────────────

    async def list_folder_status(
        self, uid: int, db: AsyncSession
    ) -> list[dict]:
        """For each alive folder of this user, count how many bvids have
        *all* their pages vectorized (is_vectorized='done').

        Returns a list of dicts: {media_id, indexed_count, media_count, last_sync_at}.
        """
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

        folder_meta = {
            row.media_id: (row.media_count, row.last_sync_at) for row in folders
        }
        media_ids = list(folder_meta.keys())

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
            )
            .select_from(Collection)
            .join(Video, Video.bvid == Collection.bvid)
            .where(
                Collection.media_id.in_(media_ids),
                ~Video.bvid.in_(select(incomplete_sub.c.bvid)),
            )
            .group_by(Collection.media_id)
        )
        count_map = {row[0]: row[1] for row in counts_result.all()}

        return [
            {
                "media_id": media_id,
                "indexed_count": count_map.get(media_id, 0),
                "media_count": meta[0],
                "last_sync_at": meta[1],
            }
            for media_id, meta in folder_meta.items()
        ]

    # ── Vectorized pages ───────────────────────────────────────────

    async def list_vectorized_pages(
        self, uid: int, db: AsyncSession
    ) -> list[dict]:
        """Return all fully-vectorized pages belonging to this user's folders."""
        folders_result = await db.execute(
            select(FavoriteFolder.media_id).where(
                FavoriteFolder.uid == uid,
                FavoriteFolder.deleted_at.is_(None),
            )
        )
        media_ids = [row[0] for row in folders_result.all()]
        if not media_ids:
            return []

        bvids_result = await db.execute(
            select(Collection.bvid).where(Collection.media_id.in_(media_ids))
        )
        bvids = list({row[0] for row in bvids_result.all() if row[0]})
        if not bvids:
            return []

        pages_result = await db.execute(
            select(Video)
            .where(Video.bvid.in_(bvids), Video.is_vectorized == "done")
            .order_by(Video.bvid, Video.page_index)
        )
        pages = pages_result.scalars().all()
        if not pages:
            return []

        bvid_set = {p.bvid for p in pages}
        titles_result = await db.execute(
            select(Collection.bvid, Collection.title).where(
                Collection.bvid.in_(bvid_set)
            )
        )
        title_map = {row[0]: row[1] for row in titles_result.all()}

        return [
            {
                "bvid": p.bvid,
                "cid": p.cid,
                "page_index": p.page_index,
                "page_title": p.page_title,
                "video_title": title_map.get(p.bvid, ""),
                "vector_chunk_count": p.vector_chunk_count or 0,
                "vectorized_at": p.vectorized_at,
            }
            for p in pages
        ]

    # ── Build status ───────────────────────────────────────────────

    async def get_build_status_row(
        self, task_id: str, uid: int, db: AsyncSession
    ) -> Optional[AsyncTask]:
        """Fetch the persisted AsyncTask row for a build task, if any.

        Scoped by uid to prevent IDOR — callers don't need to remember to
        add the ownership check; this returns None if the task belongs to
        another user.
        """
        result = await db.execute(
            select(AsyncTask).where(
                AsyncTask.task_id == task_id,
                AsyncTask.uid == uid,
            )
        )
        return result.scalar_one_or_none()

    # ── Ownership check for delete_video ───────────────────────────

    async def bvid_belongs_to_user(
        self, bvid: str, uid: int, db: AsyncSession
    ) -> bool:
        """True iff ``bvid`` is in any of the caller's alive favorite folders."""
        result = await db.execute(
            select(Collection)
            .join(
                FavoriteFolder, FavoriteFolder.media_id == Collection.media_id
            )
            .where(
                Collection.bvid == bvid,
                FavoriteFolder.uid == uid,
                FavoriteFolder.deleted_at.is_(None),
            )
            .limit(1)
        )
        return result.scalar_one_or_none() is not None


# ── Module-level singleton ────────────────────────────────────────

_repo: Optional[KnowledgeRepository] = None


def get_knowledge_repository() -> KnowledgeRepository:
    global _repo
    if _repo is None:
        _repo = KnowledgeRepository()
    return _repo
