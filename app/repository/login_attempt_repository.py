"""LoginAttemptRepository — login_attempts table CRUD.

Stores one row per login attempt (success or failure). Used by
RateLimitService to count recent failures by ip / email / uid and
enforce cooldown after repeated failures.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import LoginAttempt


class LoginAttemptRepository:
    """Data access for the login_attempts table."""

    async def create(
        self,
        db: AsyncSession,
        *,
        uid: Optional[int],
        email: Optional[str],
        ip: str,
        device_id: Optional[str],
        success: bool,
        failure_reason: Optional[str] = None,
    ) -> LoginAttempt:
        """Insert a login attempt record."""
        now = datetime.now(timezone.utc)
        la = LoginAttempt(
            uid=uid,
            email=email,
            ip=ip,
            device_id=device_id,
            success=success,
            failure_reason=failure_reason,
            created_at=now,
        )
        db.add(la)
        await db.flush()
        return la

    async def count_recent_failures_by_ip(
        self,
        db: AsyncSession,
        *,
        ip: str,
        since: datetime,
    ) -> int:
        """Count failed login attempts from ip since `since`."""
        result = await db.execute(
            select(func.count(LoginAttempt.id)).where(
                LoginAttempt.ip == ip,
                LoginAttempt.success.is_(False),
                LoginAttempt.created_at >= since,
            )
        )
        return int(result.scalar() or 0)

    async def count_recent_failures_by_email(
        self,
        db: AsyncSession,
        *,
        email: str,
        since: datetime,
    ) -> int:
        """Count failed login attempts for email since `since`."""
        result = await db.execute(
            select(func.count(LoginAttempt.id)).where(
                LoginAttempt.email == email,
                LoginAttempt.success.is_(False),
                LoginAttempt.created_at >= since,
            )
        )
        return int(result.scalar() or 0)

    async def count_recent_failures_by_uid(
        self,
        db: AsyncSession,
        *,
        uid: int,
        since: datetime,
    ) -> int:
        """Count failed login attempts for uid since `since`."""
        result = await db.execute(
            select(func.count(LoginAttempt.id)).where(
                LoginAttempt.uid == uid,
                LoginAttempt.success.is_(False),
                LoginAttempt.created_at >= since,
            )
        )
        return int(result.scalar() or 0)

    async def has_recent_success_by_email(
        self,
        db: AsyncSession,
        *,
        email: str,
        since: datetime,
    ) -> bool:
        """Return True if there's a successful login for email since `since`.

        Used to skip cooldown for accounts that have recently logged in
        successfully (avoid locking out active users).
        """
        result = await db.execute(
            select(func.count(LoginAttempt.id)).where(
                LoginAttempt.email == email,
                LoginAttempt.success.is_(True),
                LoginAttempt.created_at >= since,
            )
        )
        return int(result.scalar() or 0) > 0


_la_repo: Optional[LoginAttemptRepository] = None


def get_login_attempt_repository() -> LoginAttemptRepository:
    global _la_repo
    if _la_repo is None:
        _la_repo = LoginAttemptRepository()
    return _la_repo
