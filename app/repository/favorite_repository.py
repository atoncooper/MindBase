"""
FavoriteFolder CRUD repository.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import FavoriteFolder

_ALIVE = FavoriteFolder.deleted_at == None  # noqa: E711


class FavoriteRepository:
    """Persistence operations for favorite_folders."""

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


# Module-level singleton
_repo: Optional[FavoriteRepository] = None


def get_favorite_repository() -> FavoriteRepository:
    global _repo
    if _repo is None:
        _repo = FavoriteRepository()
    return _repo
