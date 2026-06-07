"""
UserOAuthRepository — user_oauth table CRUD.

Encryption/decryption of token fields is handled at the service layer,
not here.
"""

from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models import UserOAuth


class UserOAuthRepository:
    """Data access for the user_oauth table."""

    async def find_by_provider(
        self, provider: str, provider_uid: str, db: AsyncSession,
    ) -> Optional[UserOAuth]:
        """Look up a non-deleted OAuth binding by (provider, provider_uid)."""
        result = await db.execute(
            select(UserOAuth).where(
                UserOAuth.provider == provider,
                UserOAuth.provider_uid == provider_uid,
                UserOAuth.deleted_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def create(self, uid: int, db: AsyncSession, *,
                     provider: str, provider_uid: str,
                     access_token: Optional[str] = None,
                     refresh_token: Optional[str] = None,
                     expires_at=None, raw_data: Optional[str] = None,
                     is_primary: bool = False) -> UserOAuth:
        record = UserOAuth(
            uid=uid,
            provider=provider,
            provider_uid=provider_uid,
            access_token=access_token,
            refresh_token=refresh_token,
            expires_at=expires_at,
            raw_data=raw_data,
            is_primary=is_primary,
        )
        db.add(record)
        await db.commit()
        await db.refresh(record)
        logger.info(f"[OAUTH_REPO] created uid={uid} {provider}:{provider_uid}")
        return record

    async def update_tokens(
        self, record: UserOAuth, db: AsyncSession, *,
        access_token: Optional[str] = None,
        refresh_token: Optional[str] = None, expires_at=None,
        raw_data: Optional[str] = None,
    ) -> UserOAuth:
        """Update token fields on an existing OAuth binding (partial update)."""
        if access_token is not None:
            record.access_token = access_token
        if refresh_token is not None:
            record.refresh_token = refresh_token
        if expires_at is not None:
            record.expires_at = expires_at
        if raw_data is not None:
            record.raw_data = raw_data
        await db.commit()
        await db.refresh(record)
        return record

    async def list_by_uid(self, uid: int, db: AsyncSession) -> list[UserOAuth]:
        """List all non-deleted OAuth bindings for a user."""
        result = await db.execute(
            select(UserOAuth).where(
                UserOAuth.uid == uid,
                UserOAuth.deleted_at.is_(None),
            )
        )
        return list(result.scalars().all())

    async def count_by_uid(self, uid: int, db: AsyncSession) -> int:
        """Count non-deleted OAuth bindings for a user."""
        from sqlalchemy import func
        result = await db.execute(
            select(func.count()).where(
                UserOAuth.uid == uid,
                UserOAuth.deleted_at.is_(None),
            )
        )
        return result.scalar() or 0

    async def soft_delete(self, record: UserOAuth, db: AsyncSession) -> None:
        """Mark an OAuth binding as unbound."""
        from datetime import datetime, timezone
        record.deleted_at = datetime.now(timezone.utc)
        await db.commit()
        logger.info(f"[OAUTH_REPO] soft-deleted uid={record.uid} {record.provider}:{record.provider_uid}")


_oauth_repo: Optional[UserOAuthRepository] = None


def get_user_oauth_repository() -> UserOAuthRepository:
    global _oauth_repo
    if _oauth_repo is None:
        _oauth_repo = UserOAuthRepository()
    return _oauth_repo
