"""
UserProfileRepository — user_profile table CRUD.
"""

from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import UserProfile


class UserProfileRepository:
    """Data access for the user_profile table."""

    async def get_by_uid(self, uid: int, db: AsyncSession) -> Optional[UserProfile]:
        result = await db.execute(
            select(UserProfile).where(
                UserProfile.uid == uid, UserProfile.deleted_at.is_(None)
            )
        )
        return result.scalar_one_or_none()

    async def upsert(self, uid: int, db: AsyncSession, *,
                     nickname: Optional[str] = None,
                     avatar: Optional[str] = None,
                     bio: Optional[str] = None,
                     birthday=None,
                     gender: Optional[str] = None,
                     location: Optional[str] = None,
                     timezone: Optional[str] = None,
                     language: Optional[str] = None) -> UserProfile:
        """Create or partially update a profile row. None values are skipped."""
        record = await self.get_by_uid(uid, db)
        if record is None:
            record = UserProfile(uid=uid)
            db.add(record)

        field_map = {
            "nickname": nickname, "avatar": avatar, "bio": bio,
            "birthday": birthday, "gender": gender,
            "location": location, "timezone": timezone, "language": language,
        }
        for field, value in field_map.items():
            if value is not None:
                setattr(record, field, value)

        await db.commit()
        await db.refresh(record)
        return record


_profile_repo: Optional[UserProfileRepository] = None


def get_user_profile_repository() -> UserProfileRepository:
    global _profile_repo
    if _profile_repo is None:
        _profile_repo = UserProfileRepository()
    return _profile_repo
