"""
CloudFile CRUD repository — typed operations for cloud_files table.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import select, func, update as sa_update, or_
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models import CloudFile

_ALIVE = CloudFile.deleted_at == None  # noqa: E711

# Sentinel for "do not change folder_id" in update_meta()
_NO_CHANGE = object()


class CloudFileRepository:
    """Persistence for cloud_files (uploaded media file metadata)."""

    # ------------------------------------------------------------------
    # create
    # ------------------------------------------------------------------

    async def create(
        self,
        *,
        upload_uuid: str,
        uid: int,
        original_name: str,
        file_size: int,
        mime_type: str,
        folder_id: int | None,
        bucket: str,
        object_key: str,
        db: AsyncSession,
    ) -> CloudFile:
        """Insert a new CloudFile row in 'uploading' state."""
        file = CloudFile(
            upload_uuid=upload_uuid,
            uid=uid,
            folder_id=folder_id,
            original_name=original_name,
            file_size=file_size,
            mime_type=mime_type,
            bucket=bucket,
            object_key=object_key,
            upload_status="uploading",
            asr_status="pending",
            vector_status="pending",
        )
        db.add(file)
        await db.commit()
        await db.refresh(file)
        logger.info(
            f"[CLOUD_FILE_REPO] created upload_uuid={upload_uuid} "
            f"uid={uid} name={original_name!r} size={file_size}"
        )
        return file

    # ------------------------------------------------------------------
    # upload lifecycle
    # ------------------------------------------------------------------

    async def update_upload_completed(
        self, upload_uuid: str, etag: str, db: AsyncSession,
    ) -> None:
        """Mark upload as completed and store the MinIO ETag."""
        result = await db.execute(
            sa_update(CloudFile)
            .where(CloudFile.upload_uuid == upload_uuid)
            .values(upload_status="completed", etag=etag, updated_at=datetime.utcnow())
        )
        await db.commit()
        if result.rowcount == 0:
            logger.warning(
                f"[CLOUD_FILE_REPO] update_upload_completed: "
                f"no row for upload_uuid={upload_uuid}"
            )

    async def update_upload_failed(
        self, upload_uuid: str, db: AsyncSession,
    ) -> None:
        """Mark upload as failed."""
        result = await db.execute(
            sa_update(CloudFile)
            .where(CloudFile.upload_uuid == upload_uuid)
            .values(upload_status="failed", updated_at=datetime.utcnow())
        )
        await db.commit()
        if result.rowcount == 0:
            logger.warning(
                f"[CLOUD_FILE_REPO] update_upload_failed: "
                f"no row for upload_uuid={upload_uuid}"
            )

    # ------------------------------------------------------------------
    # read
    # ------------------------------------------------------------------

    async def get_by_uuid(
        self, upload_uuid: str, uid: int, db: AsyncSession,
    ) -> Optional[CloudFile]:
        result = await db.execute(
            select(CloudFile).where(
                CloudFile.upload_uuid == upload_uuid,
                CloudFile.uid == uid,
                _ALIVE,
            )
        )
        return result.scalar_one_or_none()

    async def list_by_folder(
        self,
        uid: int,
        folder_id: int | None,
        db: AsyncSession,
        *,
        page: int = 1,
        page_size: int = 50,
        sort: str = "created_at",
        order: str = "desc",
    ) -> tuple[list[CloudFile], int]:
        """Paginated list of files in a folder.

        *folder_id* = None lists files at the root level.
        """
        base = select(CloudFile).where(
            CloudFile.uid == uid,
            CloudFile.folder_id == folder_id,
            _ALIVE,
        )

        # Count total
        count_result = await db.execute(
            select(func.count()).select_from(base.subquery())
        )
        total = count_result.scalar() or 0

        # Sort (whitelist to avoid probing non-existent attrs)
        _SORT_WHITELIST = {"created_at", "updated_at", "file_size", "original_name", "title"}
        if sort not in _SORT_WHITELIST:
            sort = "created_at"
        sort_col = getattr(CloudFile, sort, CloudFile.created_at)
        if order == "asc":
            base = base.order_by(sort_col.asc())
        else:
            base = base.order_by(sort_col.desc())

        # Paginate
        offset = (page - 1) * page_size
        result = await db.execute(base.offset(offset).limit(page_size))
        return list(result.scalars().all()), total

    async def search(
        self,
        uid: int,
        keyword: str,
        db: AsyncSession,
        *,
        page: int = 1,
        page_size: int = 50,
    ) -> tuple[list[CloudFile], int]:
        """Keyword search across title and original_name."""
        pattern = f"%{keyword}%"
        base = select(CloudFile).where(
            CloudFile.uid == uid,
            _ALIVE,
            or_(
                CloudFile.title.ilike(pattern),
                CloudFile.original_name.ilike(pattern),
            ),
        )

        # Count total
        count_result = await db.execute(
            select(func.count()).select_from(base.subquery())
        )
        total = count_result.scalar() or 0

        # Paginate
        offset = (page - 1) * page_size
        result = await db.execute(
            base.order_by(CloudFile.created_at.desc()).offset(offset).limit(page_size)
        )
        return list(result.scalars().all()), total

    # ------------------------------------------------------------------
    # meta update
    # ------------------------------------------------------------------

    async def update_meta(
        self,
        upload_uuid: str,
        uid: int,
        *,
        title: str | None = None,
        description: str | None = None,
        tags: list[str] | None = None,
        folder_id: int | None = _NO_CHANGE,  # type: ignore[assignment]
        db: AsyncSession,
    ) -> CloudFile:
        """Update file metadata.  When *folder_id* is provided, move the
        file to a different folder and adjust video_count on both old and
        new folders."""
        file = await self.get_by_uuid(upload_uuid, uid, db)
        if file is None:
            raise ValueError(
                f"CloudFile {upload_uuid} not found for user {uid}"
            )

        if title is not None:
            file.title = title
        if description is not None:
            file.description = description
        if tags is not None:
            file.tags = tags

        if folder_id is not _NO_CHANGE:
            old_folder_id = file.folder_id
            if folder_id != old_folder_id:
                from app.repository.cloud.folder_repository import (
                    get_cloud_folder_repository,
                )
                folder_repo = get_cloud_folder_repository()

                # Decrement old folder count
                if old_folder_id is not None:
                    await folder_repo.increment_video_count(
                        old_folder_id, -1, db
                    )
                # Increment new folder count
                if folder_id is not None:
                    await folder_repo.increment_video_count(
                        folder_id, 1, db
                    )

                file.folder_id = folder_id

        file.updated_at = datetime.utcnow()
        await db.commit()
        await db.refresh(file)
        logger.info(
            f"[CLOUD_FILE_REPO] updated_meta upload_uuid={upload_uuid} uid={uid}"
        )
        return file

    # ------------------------------------------------------------------
    # status updates
    # ------------------------------------------------------------------

    async def update_asr_status(
        self, upload_uuid: str, status: str, db: AsyncSession,
    ) -> None:
        """Set ASR processing status."""
        await db.execute(
            sa_update(CloudFile)
            .where(CloudFile.upload_uuid == upload_uuid)
            .values(asr_status=status, updated_at=datetime.utcnow())
        )
        await db.commit()

    async def update_vector_status(
        self,
        upload_uuid: str,
        status: str,
        db: AsyncSession,
        *,
        chunk_count: int = 0,
    ) -> None:
        """Set vectorisation status and optional chunk count."""
        values = {
            "vector_status": status,
            "updated_at": datetime.utcnow(),
        }
        if chunk_count:
            values["vector_chunk_count"] = chunk_count
        await db.execute(
            sa_update(CloudFile)
            .where(CloudFile.upload_uuid == upload_uuid)
            .values(**values)
        )
        await db.commit()

    # ------------------------------------------------------------------
    # soft_delete
    # ------------------------------------------------------------------

    async def soft_delete(
        self, upload_uuid: str, uid: int, db: AsyncSession,
    ) -> CloudFile:
        """Soft-delete a file (sets deleted_at).  Decrements folder
        video_count."""
        file = await self.get_by_uuid(upload_uuid, uid, db)
        if file is None:
            raise ValueError(
                f"CloudFile {upload_uuid} not found for user {uid}"
            )

        if file.folder_id is not None:
            from app.repository.cloud.folder_repository import (
                get_cloud_folder_repository,
            )
            folder_repo = get_cloud_folder_repository()
            await folder_repo.increment_video_count(file.folder_id, -1, db)

        file.deleted_at = datetime.utcnow()
        await db.commit()
        await db.refresh(file)
        logger.info(
            f"[CLOUD_FILE_REPO] soft_deleted upload_uuid={upload_uuid} uid={uid}"
        )
        return file

    # ------------------------------------------------------------------
    # aggregates
    # ------------------------------------------------------------------

    async def count_by_user(self, uid: int, db: AsyncSession) -> int:
        result = await db.execute(
            select(func.count()).where(
                CloudFile.uid == uid, _ALIVE,
            )
        )
        return result.scalar() or 0

    async def total_size_by_user(self, uid: int, db: AsyncSession) -> int:
        result = await db.execute(
            select(func.coalesce(func.sum(CloudFile.file_size), 0)).where(
                CloudFile.uid == uid, _ALIVE,
            )
        )
        return result.scalar() or 0


# Module-level singleton
_repo: Optional[CloudFileRepository] = None


def get_cloud_file_repository() -> CloudFileRepository:
    global _repo
    if _repo is None:
        _repo = CloudFileRepository()
    return _repo
