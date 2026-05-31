"""
FavoriteFolder + FavoriteVideo CRUD repository.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import select, update, delete, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import FavoriteFolder, FavoriteVideo

_ALIVE = FavoriteFolder.deleted_at == None  # noqa: E711


class FavoriteRepository:
    """Persistence operations for favorite_folders and favorite_videos."""

    # ── FavoriteFolder ──────────────────────────────────────────

    async def list_folders_by_uid(self, uid: int, db: AsyncSession) -> list[FavoriteFolder]:
        result = await db.execute(
            select(FavoriteFolder)
            .where(FavoriteFolder.uid == uid, _ALIVE)
            .order_by(FavoriteFolder.updated_at.desc())
        )
        return list(result.scalars().all())

    async def get_folder_by_uid_media(
        self, uid: int, media_id: int, db: AsyncSession
    ) -> Optional[FavoriteFolder]:
        result = await db.execute(
            select(FavoriteFolder).where(
                FavoriteFolder.uid == uid,
                FavoriteFolder.media_id == media_id,
                _ALIVE,
            )
        )
        return result.scalar_one_or_none()

    async def upsert_folder(
        self,
        uid: int,
        media_id: int,
        title: str,
        media_count: int,
        is_default: bool,
        db: AsyncSession,
    ) -> FavoriteFolder:
        existing = await self.get_folder_by_uid_media(uid, media_id, db)
        now = datetime.utcnow()
        if existing:
            existing.title = title
            existing.media_count = media_count
            existing.is_default = is_default
            existing.last_sync_at = now
            existing.updated_at = now
            await db.commit()
            await db.refresh(existing)
            return existing

        folder = FavoriteFolder(
            uid=uid,
            media_id=media_id,
            title=title,
            media_count=media_count,
            is_default=is_default,
            last_sync_at=now,
        )
        db.add(folder)
        await db.commit()
        await db.refresh(folder)
        return folder

    async def update_folder_selected(
        self, folder_id: int, is_selected: bool, db: AsyncSession
    ) -> None:
        await db.execute(
            update(FavoriteFolder)
            .where(FavoriteFolder.id == folder_id)
            .values(is_selected=is_selected, updated_at=datetime.utcnow())
        )
        await db.commit()

    async def soft_delete_folder(self, folder_id: int, db: AsyncSession) -> bool:
        result = await db.execute(
            update(FavoriteFolder)
            .where(FavoriteFolder.id == folder_id, _ALIVE)
            .values(deleted_at=datetime.utcnow(), updated_at=datetime.utcnow())
        )
        await db.commit()
        return result.rowcount > 0

    # ── FavoriteVideo ───────────────────────────────────────────

    async def list_videos_by_folder(
        self, folder_id: int, db: AsyncSession
    ) -> list[FavoriteVideo]:
        result = await db.execute(
            select(FavoriteVideo).where(FavoriteVideo.folder_id == folder_id)
        )
        return list(result.scalars().all())

    async def upsert_video(
        self,
        folder_id: int,
        video_id: int,
        bvid: str,
        db: AsyncSession,
    ) -> FavoriteVideo:
        result = await db.execute(
            select(FavoriteVideo).where(
                FavoriteVideo.folder_id == folder_id,
                FavoriteVideo.video_id == video_id,
            )
        )
        existing = result.scalar_one_or_none()
        if existing:
            existing.is_selected = True
            await db.commit()
            await db.refresh(existing)
            return existing

        fv = FavoriteVideo(
            folder_id=folder_id,
            video_id=video_id,
            bvid=bvid,
            is_selected=True,
        )
        db.add(fv)
        await db.commit()
        await db.refresh(fv)
        return fv

    async def bulk_upsert_videos(
        self,
        folder_id: int,
        videos: list[dict],  # [{"video_id": int, "bvid": str}, ...]
        db: AsyncSession,
    ) -> int:
        """Upsert a batch of video links; returns count of newly added rows."""
        existing_result = await db.execute(
            select(FavoriteVideo.video_id).where(
                FavoriteVideo.folder_id == folder_id
            )
        )
        existing_ids = {row[0] for row in existing_result.all()}

        added = 0
        for v in videos:
            vid = v["video_id"]
            bvid = v["bvid"]
            if vid not in existing_ids:
                db.add(FavoriteVideo(
                    folder_id=folder_id,
                    video_id=vid,
                    bvid=bvid,
                    is_selected=True,
                ))
                existing_ids.add(vid)
                added += 1

        if added:
            await db.commit()
        return added

    async def remove_videos(
        self, folder_id: int, video_ids: list[int], db: AsyncSession
    ) -> int:
        """Remove video links from a folder; returns count of deleted rows."""
        result = await db.execute(
            delete(FavoriteVideo).where(
                FavoriteVideo.folder_id == folder_id,
                FavoriteVideo.video_id.in_(video_ids),
            )
        )
        await db.commit()
        return result.rowcount

    async def count_videos(self, folder_id: int, db: AsyncSession) -> int:
        result = await db.execute(
            select(func.count()).where(FavoriteVideo.folder_id == folder_id)
        )
        return result.scalar() or 0

    async def list_videos_paginated(
        self, folder_id: int, offset: int, limit: int, db: AsyncSession
    ) -> tuple[list[dict], int]:
        """Paginated video list with video_cache JOIN; returns (rows, total)."""
        from app.models import Collection as CollectionModel

        total = await self.count_videos(folder_id, db)

        result = await db.execute(
            select(
                FavoriteVideo.id,
                FavoriteVideo.is_selected,
                FavoriteVideo.created_at,
                CollectionModel.bvid,
                CollectionModel.title,
                CollectionModel.cover,
                CollectionModel.duration,
                CollectionModel.owner_name,
                CollectionModel.cid,
            )
            .join(CollectionModel, CollectionModel.id == FavoriteVideo.video_id, isouter=True)
            .where(FavoriteVideo.folder_id == folder_id)
            .order_by(FavoriteVideo.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
        rows = [
            {
                "id": row.id,
                "bvid": row.bvid,
                "title": row.title,
                "cover": row.cover,
                "duration": row.duration,
                "owner": row.owner_name,
                "cid": row.cid,
                "is_selected": row.is_selected,
                "synced_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in result.all()
        ]
        return rows, total


# Module-level singleton
_repo: Optional[FavoriteRepository] = None


def get_favorite_repository() -> FavoriteRepository:
    global _repo
    if _repo is None:
        _repo = FavoriteRepository()
    return _repo
