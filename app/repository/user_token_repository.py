"""
UserTokenRepository — user_tokens table CRUD.

Handles token create, validate, and revoke operations at the data layer.
"""

from datetime import datetime, timezone, timedelta
from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models import UserToken

DEFAULT_TOKEN_TTL_DAYS = 30


class UserTokenRepository:
    """Data access for the user_tokens table."""

    async def list_active(self, uid: int, db: AsyncSession) -> list[UserToken]:
        """Return all valid (non-revoked, non-expired) tokens for a user."""
        result = await db.execute(
            select(UserToken).where(
                UserToken.uid == uid,
                UserToken.is_revoked == False,  # noqa: E712
                UserToken.deleted_at == None,  # noqa: E711
            )
        )
        tokens = result.scalars().all()
        now = datetime.now(timezone.utc)
        return [
            t
            for t in tokens
            if t.expires_at is None or t.expires_at.replace(tzinfo=timezone.utc) > now
        ]

    async def revoke_by_id(
        self, session_token: str, uid: int, db: AsyncSession
    ) -> bool:
        """Revoke a specific token, verifying ownership. Returns True if revoked."""
        result = await db.execute(
            select(UserToken).where(
                UserToken.session_token == session_token,
                UserToken.uid == uid,
                UserToken.is_revoked == False,  # noqa: E712
            )
        )
        token = result.scalar_one_or_none()
        if token is None:
            return False
        token.is_revoked = True
        token.deleted_at = datetime.now(timezone.utc)
        await db.commit()
        logger.info(f"[TOKEN_REPO] revoked token for uid={uid}")
        return True

    async def create(
        self,
        db: AsyncSession,
        *,
        uid: int,
        session_token: str,
        device_id: Optional[str] = None,
        ip: Optional[str] = None,
        user_agent: Optional[str] = None,
        ttl_days: int = DEFAULT_TOKEN_TTL_DAYS,
        commit: bool = True,
    ) -> UserToken:
        token = UserToken(
            session_token=session_token,
            uid=uid,
            device_id=device_id,
            token_type="access",
            expires_at=datetime.now(timezone.utc) + timedelta(days=ttl_days),
            ip=ip,
            user_agent=user_agent,
        )
        db.add(token)
        if commit:
            await db.commit()
            await db.refresh(token)
        else:
            await db.flush()
        logger.info(f"[TOKEN_REPO] created token for uid={uid}")
        return token

    async def find_valid(
        self, session_token: str, db: AsyncSession
    ) -> Optional[UserToken]:
        """Return the token row if it is valid (exists, not revoked, not expired)."""
        result = await db.execute(
            select(UserToken).where(UserToken.session_token == session_token)
        )
        token = result.scalar_one_or_none()
        if token is None:
            return None
        if token.is_revoked:
            return None
        if token.deleted_at is not None:
            return None
        if token.expires_at and token.expires_at.replace(
            tzinfo=timezone.utc
        ) < datetime.now(timezone.utc):
            return None
        return token

    async def bump_activity(self, token: UserToken, db: AsyncSession) -> None:
        token.last_active_at = datetime.now(timezone.utc)
        await db.commit()

    async def revoke(self, token: UserToken, db: AsyncSession) -> None:
        """Revoke a single token (soft)."""
        token.is_revoked = True
        token.deleted_at = datetime.now(timezone.utc)
        await db.commit()
        logger.info(f"[TOKEN_REPO] revoked token for uid={token.uid}")

    async def revoke_all_for_user(self, uid: int, db: AsyncSession) -> None:
        """Revoke every active token for a user."""
        await db.execute(
            update(UserToken)
            .where(UserToken.uid == uid, UserToken.is_revoked == False)  # noqa: E712
            .values(is_revoked=True, deleted_at=datetime.now(timezone.utc))
        )
        await db.commit()
        logger.info(f"[TOKEN_REPO] revoked all tokens for uid={uid}")


_token_repo: Optional[UserTokenRepository] = None


def get_user_token_repository() -> UserTokenRepository:
    global _token_repo
    if _token_repo is None:
        _token_repo = UserTokenRepository()
    return _token_repo
