"""
CloudUploadSession CRUD repository — typed operations for cloud_upload_sessions.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models import CloudUploadSession


class CloudSessionRepository:
    """Persistence for cloud_upload_sessions (groups multiple file uploads)."""

    # ------------------------------------------------------------------
    # create
    # ------------------------------------------------------------------

    async def create(
        self,
        session_uuid: str,
        uid: int,
        minio_upload_id: str | None,
        total_files: int,
        db: AsyncSession,
    ) -> CloudUploadSession:
        """Start a new upload session."""
        session = CloudUploadSession(
            session_uuid=session_uuid,
            uid=uid,
            minio_upload_id=minio_upload_id,
            total_files=total_files,
            completed_files=0,
            status="active",
            last_heartbeat=datetime.utcnow(),
        )
        db.add(session)
        await db.commit()
        await db.refresh(session)
        logger.info(
            f"[CLOUD_SESSION_REPO] created session_uuid={session_uuid} "
            f"uid={uid} total_files={total_files}"
        )
        return session

    # ------------------------------------------------------------------
    # lifecycle transitions
    # ------------------------------------------------------------------

    async def mark_completed(
        self, session_uuid: str, db: AsyncSession,
    ) -> None:
        """Mark session as completed."""
        session = await self._get_by_uuid(session_uuid, db)
        if session:
            session.status = "completed"
            session.last_heartbeat = datetime.utcnow()
            await db.commit()
            logger.info(
                f"[CLOUD_SESSION_REPO] completed session_uuid={session_uuid}"
            )

    async def mark_completed_by_minio_upload_id(
        self, minio_upload_id: str, db: AsyncSession,
    ) -> None:
        """Mark session as completed, looked up by minio_upload_id."""
        result = await db.execute(
            select(CloudUploadSession).where(
                CloudUploadSession.minio_upload_id == minio_upload_id,
            )
        )
        session = result.scalar_one_or_none()
        if session:
            session.status = "completed"
            session.last_heartbeat = datetime.utcnow()
            await db.commit()
            logger.info(
                "[CLOUD_SESSION_REPO] completed minio_upload_id=%s session_uuid=%s",
                minio_upload_id, session.session_uuid,
            )

    async def mark_abandoned(
        self, session_uuid: str, db: AsyncSession,
    ) -> None:
        """Mark session as abandoned."""
        session = await self._get_by_uuid(session_uuid, db)
        if session:
            session.status = "abandoned"
            session.last_heartbeat = datetime.utcnow()
            await db.commit()
            logger.info(
                f"[CLOUD_SESSION_REPO] abandoned session_uuid={session_uuid}"
            )

    # ------------------------------------------------------------------
    # read
    # ------------------------------------------------------------------

    async def get_active_sessions(
        self, db: AsyncSession,
    ) -> list[CloudUploadSession]:
        """Return all sessions currently in 'active' status."""
        result = await db.execute(
            select(CloudUploadSession).where(
                CloudUploadSession.status == "active"
            )
        )
        return list(result.scalars().all())

    async def _get_by_uuid(
        self, session_uuid: str, db: AsyncSession,
    ) -> Optional[CloudUploadSession]:
        result = await db.execute(
            select(CloudUploadSession).where(
                CloudUploadSession.session_uuid == session_uuid,
            )
        )
        return result.scalar_one_or_none()


# Module-level singleton
_repo: Optional[CloudSessionRepository] = None


def get_cloud_session_repository() -> CloudSessionRepository:
    global _repo
    if _repo is None:
        _repo = CloudSessionRepository()
    return _repo
