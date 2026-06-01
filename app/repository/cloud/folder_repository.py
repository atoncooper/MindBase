"""
CloudFolder CRUD repository — typed operations for cloud_folders table.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models import CloudFolder, CloudFile

_ALIVE = CloudFolder.deleted_at == None  # noqa: E711

# Sentinel for "do not change parent" in update()
_NO_CHANGE = object()


class CloudFolderRepository:
    """Persistence for cloud_folders (hierarchical folder tree)."""

    # ------------------------------------------------------------------
    # create
    # ------------------------------------------------------------------

    async def create(
        self,
        uid: int,
        name: str,
        parent_id: int | None,
        db: AsyncSession,
    ) -> CloudFolder:
        """Create a new folder.  Validates parent ownership when parent_id
        is not None."""
        if parent_id is not None:
            await self.validate_ownership(parent_id, uid, db)

        folder = CloudFolder(
            uid=uid,
            parent_id=parent_id,
            name=name,
            video_count=0,
        )
        db.add(folder)
        await db.commit()
        await db.refresh(folder)
        logger.info(
            f"[CLOUD_FOLDER_REPO] created folder_id={folder.id} "
            f"uid={uid} name={name!r} parent_id={parent_id}"
        )
        return folder

    # ------------------------------------------------------------------
    # read
    # ------------------------------------------------------------------

    async def get_by_id(
        self, folder_id: int, uid: int, db: AsyncSession,
    ) -> Optional[CloudFolder]:
        result = await db.execute(
            select(CloudFolder).where(
                CloudFolder.id == folder_id,
                CloudFolder.uid == uid,
                _ALIVE,
            )
        )
        return result.scalar_one_or_none()

    async def list_by_parent(
        self, uid: int, parent_id: int | None, db: AsyncSession,
    ) -> list[CloudFolder]:
        """List direct children of *parent_id* (NULL = root folders)."""
        stmt = select(CloudFolder).where(
            CloudFolder.uid == uid,
            CloudFolder.parent_id == parent_id,
            _ALIVE,
        ).order_by(CloudFolder.sort_order, CloudFolder.name)

        result = await db.execute(stmt)
        return list(result.scalars().all())

    async def get_tree(self, uid: int, db: AsyncSession) -> list[dict]:
        """Return the entire folder tree for a user as a nested dict list."""
        result = await db.execute(
            select(CloudFolder)
            .where(CloudFolder.uid == uid, _ALIVE)
            .order_by(CloudFolder.sort_order, CloudFolder.name)
        )
        folders = list(result.scalars().all())

        # Build lookup map
        folder_map: dict[int, dict] = {}
        for f in folders:
            folder_map[f.id] = {
                "id": f.id,
                "name": f.name,
                "parent_id": f.parent_id,
                "video_count": f.video_count,
                "sort_order": f.sort_order,
                "created_at": f.created_at.isoformat() if f.created_at else None,
                "updated_at": f.updated_at.isoformat() if f.updated_at else None,
                "children": [],
            }

        roots: list[dict] = []
        for f in folders:
            node = folder_map[f.id]
            if f.parent_id is not None and f.parent_id in folder_map:
                folder_map[f.parent_id]["children"].append(node)
            else:
                roots.append(node)

        return roots

    # ------------------------------------------------------------------
    # update
    # ------------------------------------------------------------------

    async def update(
        self,
        folder_id: int,
        uid: int,
        *,
        name: str | None = None,
        parent_id: int | None = _NO_CHANGE,  # type: ignore[assignment]
        db: AsyncSession,
    ) -> CloudFolder:
        """Update folder name and/or move to new parent (with cycle detection).

        *parent_id* uses ``_NO_CHANGE`` sentinel as default so callers can
        distinguish "don't move" (omit the param) from "move to root"
        (pass ``parent_id=None``).
        """
        folder = await self.validate_ownership(folder_id, uid, db)

        if name is not None:
            folder.name = name

        if parent_id is not _NO_CHANGE:
            await self._validate_and_move(folder, parent_id, uid, db)

        folder.updated_at = datetime.utcnow()
        await db.commit()
        await db.refresh(folder)
        logger.info(
            f"[CLOUD_FOLDER_REPO] updated folder_id={folder_id} uid={uid}"
        )
        return folder

    async def move_folder(
        self,
        folder_id: int,
        uid: int,
        new_parent_id: int | None,
        db: AsyncSession,
    ) -> CloudFolder:
        """Move a folder to a new parent (convenience wrapper with cycle
        detection)."""
        folder = await self.validate_ownership(folder_id, uid, db)
        await self._validate_and_move(folder, new_parent_id, uid, db)
        folder.updated_at = datetime.utcnow()
        await db.commit()
        await db.refresh(folder)
        logger.info(
            f"[CLOUD_FOLDER_REPO] moved folder_id={folder_id} "
            f"uid={uid} new_parent_id={new_parent_id}"
        )
        return folder

    async def _validate_and_move(
        self,
        folder: CloudFolder,
        new_parent_id: int | None,
        uid: int,
        db: AsyncSession,
    ) -> None:
        """Check ownership and cycles, then update parent_id in-place."""
        if new_parent_id == folder.id:
            raise ValueError("Cannot move a folder into itself")

        if new_parent_id is not None:
            # Ensure new parent exists and is owned by the same user
            await self.validate_ownership(new_parent_id, uid, db)
            # Cycle detection: new parent must not be a descendant of folder
            if await self._is_descendant(folder.id, new_parent_id, uid, db):
                raise ValueError(
                    f"Cannot move folder {folder.id} into its own descendant "
                    f"{new_parent_id}"
                )

        folder.parent_id = new_parent_id

    # ------------------------------------------------------------------
    # increment_video_count
    # ------------------------------------------------------------------

    async def increment_video_count(
        self, folder_id: int, delta: int, db: AsyncSession,
    ) -> None:
        """Atomically adjust video_count by *delta* (may be negative)."""
        await db.execute(
            sa_update(CloudFolder)
            .where(CloudFolder.id == folder_id)
            .values(video_count=CloudFolder.video_count + delta)
        )
        await db.commit()

    # ------------------------------------------------------------------
    # soft_delete
    # ------------------------------------------------------------------

    async def soft_delete(
        self, folder_id: int, uid: int, force: bool, db: AsyncSession,
    ) -> int:
        """Soft-delete a folder and (when *force*) its entire subtree.

        Returns
        -------
        int
            Number of CloudFile rows that were soft-deleted.
        """
        folder = await self.validate_ownership(folder_id, uid, db)
        now = datetime.utcnow()

        affected_count = await self._soft_delete_files_in_folder(
            folder_id, uid, now, db
        )

        if force:
            affected_count += await self._soft_delete_subtree(
                folder_id, uid, now, db
            )

        folder.deleted_at = now
        await db.commit()
        logger.info(
            f"[CLOUD_FOLDER_REPO] soft_deleted folder_id={folder_id} "
            f"uid={uid} force={force} affected_files={affected_count}"
        )
        return affected_count

    async def _soft_delete_files_in_folder(
        self, folder_id: int, uid: int, now: datetime, db: AsyncSession,
    ) -> int:
        """Soft-delete all non-deleted CloudFile rows in *folder_id*."""
        _FILE_ALIVE = CloudFile.deleted_at == None  # noqa: E711
        result = await db.execute(
            select(CloudFile).where(
                CloudFile.folder_id == folder_id,
                CloudFile.uid == uid,
                _FILE_ALIVE,
            )
        )
        files = list(result.scalars().all())
        for f in files:
            f.deleted_at = now
        return len(files)

    async def _soft_delete_subtree(
        self, folder_id: int, uid: int, now: datetime, db: AsyncSession,
    ) -> int:
        """Recursively soft-delete child folders and their files.

        Returns the total number of CloudFile rows soft-deleted within
        the subtree (not including files in *folder_id* itself).
        """
        result = await db.execute(
            select(CloudFolder).where(
                CloudFolder.parent_id == folder_id,
                CloudFolder.uid == uid,
                _ALIVE,
            )
        )
        children = list(result.scalars().all())

        total_files = 0
        for child in children:
            total_files += await self._soft_delete_files_in_folder(
                child.id, uid, now, db
            )
            total_files += await self._soft_delete_subtree(
                child.id, uid, now, db
            )
            child.deleted_at = now

        return total_files

    # ------------------------------------------------------------------
    # ownership
    # ------------------------------------------------------------------

    async def validate_ownership(
        self, folder_id: int, uid: int, db: AsyncSession,
    ) -> CloudFolder:
        """Return the folder if it belongs to *uid*, else PermissionError."""
        folder = await self.get_by_id(folder_id, uid, db)
        if folder is None:
            raise PermissionError(
                f"Folder {folder_id} not found or does not belong to user {uid}"
            )
        return folder

    # ------------------------------------------------------------------
    # cycle detection
    # ------------------------------------------------------------------

    async def _is_descendant(
        self, ancestor_id: int, child_id: int, uid: int, db: AsyncSession,
    ) -> bool:
        """Return True if *child_id* is a descendant of *ancestor_id*."""
        current_id = child_id
        visited: set[int] = set()
        while current_id and current_id not in visited:
            if current_id == ancestor_id:
                return True
            visited.add(current_id)
            folder = await self.get_by_id(current_id, uid, db)
            if folder is None or folder.parent_id is None:
                break
            current_id = folder.parent_id
        return False


# Module-level singleton
_repo: Optional[CloudFolderRepository] = None


def get_cloud_folder_repository() -> CloudFolderRepository:
    global _repo
    if _repo is None:
        _repo = CloudFolderRepository()
    return _repo
