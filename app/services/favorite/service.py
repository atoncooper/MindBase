"""
FavoriteService — business logic for favorites sync & query.

Responsibilities:
  - Fetch folder / video lists from Bilibili API
  - Upsert into favorite_folders / collection (direct — no junction table)
  - Serve local DB queries

Not responsible for:
  - HTTP request parsing (router layer)
  - Cookie management (BilibiliService injected by router)
"""

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models import FavoriteFolder, Collection
from app.services.bilibili import BilibiliService
from app.repository.favorite_repository import get_favorite_repository, FavoriteRepository


def _is_default_folder(folder: dict) -> bool:
    for key in ("is_default", "default", "isDefault"):
        if key in folder:
            return bool(folder.get(key))
    if folder.get("type") == 1:
        return True
    if folder.get("fav_state") == 1:
        return True
    if folder.get("attr") == 1:
        return True
    title = (folder.get("title") or "").strip()
    return title == "默认收藏夹"


class FavoriteService:
    """Favorites v2 business logic."""

    def __init__(self, repo: Optional[FavoriteRepository] = None):
        self._repo = repo or get_favorite_repository()

    # ── Folders ──────────────────────────────────────────────

    async def sync_folders(
        self,
        uid: int,
        bili: BilibiliService,
        bili_mid: int,
        db: AsyncSession,
    ) -> list[FavoriteFolder]:
        """Fetch all folders from Bilibili and upsert into DB."""
        logger.info(f"[FavoriteService] sync_folders uid={uid} mid={bili_mid}")
        raw_folders = await bili.get_user_favorites(mid=bili_mid)

        results: list[FavoriteFolder] = []
        for f in raw_folders:
            media_id = f.get("id") or f.get("media_id")
            if not media_id:
                continue
            record = await self._repo.upsert_folder(
                uid=uid,
                media_id=int(media_id),
                title=f.get("title", "untitled"),
                media_count=f.get("media_count", 0),
                is_default=_is_default_folder(f),
                db=db,
            )
            results.append(record)

        logger.info(f"[FavoriteService] synced {len(results)} folders")
        return results

    async def list_folders(
        self, uid: int, db: AsyncSession
    ) -> list[FavoriteFolder]:
        return await self._repo.list_folders_by_uid(uid, db)

    async def update_folder_selected(
        self, folder_id: int, is_selected: bool, db: AsyncSession
    ) -> None:
        await self._repo.update_folder_selected(folder_id, is_selected, db)

    async def delete_folder(self, folder_id: int, db: AsyncSession) -> bool:
        return await self._repo.soft_delete_folder(folder_id, db)

    # ── Videos (collection table, keyed by media_id + bvid) ──

    async def sync_videos(
        self,
        uid: int,
        folder_id: int,
        bili: BilibiliService,
        db: AsyncSession,
    ) -> dict:
        """Full sync videos from Bilibili into collection table.

        Keyed by (media_id, bvid) — upsert directly, no junction table.
        """
        folder = await self._get_folder_or_raise(folder_id, uid, db)
        media_id = folder.media_id

        logger.info(f"[FavoriteService] sync_videos folder_id={folder_id} media_id={media_id}")

        raw_videos = await bili.get_all_favorite_videos(media_id)

        if not raw_videos:
            logger.warning(f"[FavoriteService] empty video list for media_id={media_id}, skipping")
            return {"total": 0, "added": 0}

        # Full replace: delete existing rows for this media_id, then re-insert
        from sqlalchemy import delete as sa_delete
        await db.execute(sa_delete(Collection).where(Collection.media_id == media_id))
        await db.commit()

        now = datetime.now(timezone.utc)
        added = 0

        for media in raw_videos:
            bvid = media.get("bvid") or media.get("bv_id")
            title = media.get("title", "")
            if not bvid:
                continue
            attr = media.get("attr", 0)
            if attr == 9 or title in ("已失效视频", "已删除视频"):
                continue

            upper = media.get("upper") or {}
            db.add(Collection(
                media_id=media_id,
                bvid=bvid,
                title=title,
                cover=media.get("cover"),
                duration=media.get("duration"),
                owner_name=upper.get("name"),
                owner_mid=upper.get("mid"),
                description=media.get("intro"),
                cid=(media.get("ugc") or {}).get("first_cid") if media.get("ugc") else None,
            ))
            added += 1

        await db.commit()

        # Update folder metadata
        folder.media_count = added
        folder.last_sync_at = now
        folder.updated_at = now
        await db.commit()

        logger.info(f"[FavoriteService] synced {added} videos for media_id={media_id}")
        return {"total": added, "added": added}

    async def list_videos_by_media_id(
        self,
        uid: int,
        media_id: int,
        bili: BilibiliService,
        page: int,
        page_size: int,
        db: AsyncSession,
    ) -> dict:
        """List videos by Bilibili media_id with pagination.

        Queries collection WHERE media_id=? directly — no JOIN needed.
        Auto-syncs from Bilibili if no videos cached yet.
        """
        # Resolve folder (for title + permission check)
        from app.models import FavoriteFolder as FavFolder
        folder_result = await db.execute(
            select(FavFolder).where(
                FavFolder.uid == uid,
                FavFolder.media_id == media_id,
                FavFolder.deleted_at == None,  # noqa: E711
            )
        )
        folder = folder_result.scalar_one_or_none()
        if not folder:
            raise ValueError("Folder not found — sync folders first")

        # Auto-sync if no cached videos for this media_id
        count_result = await db.execute(
            select(func.count()).where(Collection.media_id == media_id)
        )
        count = count_result.scalar() or 0

        if count == 0:
            logger.info(f"[FavoriteService] auto-syncing videos for media_id={media_id}")
            await self.sync_videos(uid, folder.id, bili, db)

        # Paginated query: SELECT * FROM collection WHERE media_id = ? ORDER BY created_at DESC
        total_result = await db.execute(
            select(func.count()).where(Collection.media_id == media_id)
        )
        total = total_result.scalar() or 0

        offset = (page - 1) * page_size
        rows_result = await db.execute(
            select(Collection)
            .where(Collection.media_id == media_id)
            .order_by(Collection.created_at.desc())
            .offset(offset)
            .limit(page_size)
        )
        rows = rows_result.scalars().all()

        return {
            "folder_id": folder.id,
            "media_id": media_id,
            "folder_title": folder.title,
            "videos": [
                {
                    "id": r.id,
                    "bvid": r.bvid,
                    "title": r.title,
                    "cover": r.cover,
                    "duration": r.duration,
                    "owner": r.owner_name,
                    "cid": r.cid,
                    "is_selected": True,
                    "synced_at": r.created_at.isoformat() if r.created_at else None,
                }
                for r in rows
            ],
            "total": total,
            "page": page,
            "page_size": page_size,
            "has_more": offset + page_size < total,
        }

    # ── helpers ──────────────────────────────────────────────

    async def _get_folder_or_raise(
        self, folder_id: int, uid: int, db: AsyncSession
    ) -> FavoriteFolder:
        """Validate folder exists and belongs to uid, else raise ValueError."""
        folder = await db.get(FavoriteFolder, folder_id)
        if not folder:
            raise ValueError("Folder not found")
        if folder.deleted_at:
            raise ValueError("Folder has been deleted")
        if folder.uid is not None and folder.uid != uid:
            raise ValueError("Access denied to this folder")
        return folder
