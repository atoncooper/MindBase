"""
Session token management — generation, validation, and revocation.

Thin service layer: business rules live here, all DB operations are delegated
to UserTokenRepository.

Token lifecycle:
  generate_token()  → create_token()   → INSERT
                    → validate_token() → SELECT + bump activity (with cache)
                    → revoke_token()   → UPDATE is_revoked=True + cache invalidation
                    → revoke_all_tokens() → batch UPDATE + cache invalidation
"""

import secrets
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.repository.user_token_repository import get_user_token_repository

DEFAULT_TOKEN_TTL_DAYS = 30


def generate_token() -> str:
    """Generate a random session token: secrets.token_urlsafe(48) → 64 chars, ~256 bits entropy."""
    return secrets.token_urlsafe(48)


async def create_token(
    db: AsyncSession,
    *,
    uid: int,
    device_id: Optional[str] = None,
    ip: Optional[str] = None,
    user_agent: Optional[str] = None,
    ttl_days: int = DEFAULT_TOKEN_TTL_DAYS,
    commit: bool = True,
):
    """Create and persist a new session token."""
    repo = get_user_token_repository()
    return await repo.create(
        db,
        uid=uid,
        session_token=generate_token(),
        device_id=device_id,
        ip=ip,
        user_agent=user_agent,
        ttl_days=ttl_days,
        commit=commit,
    )


async def validate_token(db: AsyncSession, session_token: str) -> Optional[int]:
    """Validate a session token. Returns uid if valid, None otherwise.

    Hot-path caching: checks L1 local memory first to avoid DB round-trip
    on every request.
    """
    from app.services.auth import cache as auth_cache

    cached_uid = await auth_cache.get_token_uid(session_token)
    if cached_uid is not None:
        return cached_uid

    repo = get_user_token_repository()
    token = await repo.find_valid(session_token, db)
    if token is None:
        return None
    await repo.bump_activity(token, db)

    await auth_cache.set_token_uid(session_token, token.uid)
    return token.uid


async def revoke_token(db: AsyncSession, session_token: str) -> None:
    """Revoke a single token."""
    repo = get_user_token_repository()
    token = await repo.find_valid(session_token, db)
    if token is None:
        return
    await repo.revoke(token, db)

    from app.services.auth import cache as auth_cache

    await auth_cache.delete_token(session_token)


async def revoke_all_tokens(db: AsyncSession, uid: int) -> None:
    """Revoke every active token for a user."""
    repo = get_user_token_repository()
    await repo.revoke_all_for_user(uid, db)

    # Clear all token caches — we can't enumerate session tokens per uid
    from app.services.auth import cache as auth_cache

    await auth_cache.delete_all_tokens()
