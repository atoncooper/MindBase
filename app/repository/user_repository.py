"""
UserRepository — users table CRUD.

Soft-delete: queries skip rows where deleted_at IS NOT NULL.
"""

from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models import User


class UserRepository:
    """Data access for the users table."""

    async def get_by_uid(self, uid: int, db: AsyncSession) -> Optional[User]:
        result = await db.execute(
            select(User).where(User.uid == uid, User.deleted_at.is_(None))
        )
        return result.scalar_one_or_none()

    async def find_by_email(self, email: str, db: AsyncSession) -> Optional[User]:
        result = await db.execute(
            select(User).where(User.email == email, User.deleted_at.is_(None))
        )
        return result.scalar_one_or_none()

    async def create(self, uid: int, db: AsyncSession) -> User:
        user = User(uid=uid, status="active")
        db.add(user)
        await db.commit()
        await db.refresh(user)
        logger.info(f"[USER_REPO] created uid={uid}")
        return user

    async def soft_delete(self, uid: int, db: AsyncSession) -> bool:
        """Mark user as deleted (does NOT physically remove the row)."""
        from datetime import datetime, timezone
        user = await self.get_by_uid(uid, db)
        if not user:
            return False
        user.deleted_at = datetime.now(timezone.utc)
        user.status = "deleted"
        await db.commit()
        logger.info(f"[USER_REPO] soft-deleted uid={uid}")
        return True

    async def update(self, uid: int, db: AsyncSession, **fields) -> Optional[User]:
        """Partially update users row fields. Returns updated user or None."""
        user = await self.get_by_uid(uid, db)
        if not user:
            return None
        allowed = {
            "email", "phone", "password_hash",
            "email_verified", "phone_verified", "status",
        }
        for key, value in fields.items():
            if key in allowed and value is not None:
                setattr(user, key, value)
        await db.commit()
        await db.refresh(user)
        return user


_user_repo: Optional[UserRepository] = None


def get_user_repository() -> UserRepository:
    global _user_repo
    if _user_repo is None:
        _user_repo = UserRepository()
    return _user_repo
