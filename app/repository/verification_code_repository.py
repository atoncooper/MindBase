"""VerificationCodeRepository — verification_codes table CRUD.

Stores 6-digit codes for email verification (bind email, password reset,
2FA). Each code has a target (email), purpose, expiry, and used flag.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select, func, update
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models import VerificationCode


class VerificationCodeRepository:
    """Data access for the verification_codes table."""

    async def create(
        self,
        db: AsyncSession,
        *,
        uid: int,
        target: str,
        purpose: str,
        code: str,
        ttl_seconds: int,
    ) -> VerificationCode:
        """Insert a new code, return the persisted row."""
        now = datetime.now(timezone.utc)
        vc = VerificationCode(
            uid=uid,
            target=target,
            type="email",
            purpose=purpose,
            code=code,
            expires_at=now + timedelta(seconds=ttl_seconds),
            used=False,
            created_at=now,
        )
        db.add(vc)
        await db.flush()
        logger.info(
            "[VC_REPO] created uid=%s target=%s purpose=%s expires_in=%ss",
            uid, target, purpose, ttl_seconds,
        )
        return vc

    async def find_latest_unused(
        self,
        db: AsyncSession,
        *,
        target: str,
        purpose: str,
    ) -> Optional[VerificationCode]:
        """Return the most recent unused, unexpired code for target+purpose."""
        now = datetime.now(timezone.utc)
        result = await db.execute(
            select(VerificationCode)
            .where(
                VerificationCode.target == target,
                VerificationCode.purpose == purpose,
                VerificationCode.used.is_(False),
                VerificationCode.expires_at > now,
            )
            .order_by(VerificationCode.created_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def mark_used(self, db: AsyncSession, vc_id: int) -> None:
        """Mark a code as used (single-use enforcement)."""
        await db.execute(
            update(VerificationCode)
            .where(VerificationCode.id == vc_id)
            .values(used=True)
        )

    async def increment_attempts(self, db: AsyncSession, vc_id: int) -> int:
        """Increment wrong-code attempts, return new attempt count."""
        result = await db.execute(
            select(VerificationCode)
            .where(VerificationCode.id == vc_id)
        )
        vc = result.scalar_one_or_none()
        if vc is None:
            return 0
        vc.attempts = (vc.attempts or 0) + 1
        return vc.attempts

    async def count_recent_by_target(
        self,
        db: AsyncSession,
        *,
        target: str,
        since: datetime,
    ) -> int:
        """Count codes sent to target since `since` (rate limiting)."""
        result = await db.execute(
            select(func.count(VerificationCode.id)).where(
                VerificationCode.target == target,
                VerificationCode.created_at >= since,
            )
        )
        return int(result.scalar() or 0)

    async def count_recent_by_uid(
        self,
        db: AsyncSession,
        *,
        uid: int,
        since: datetime,
    ) -> int:
        """Count codes sent for uid since `since` (rate limiting)."""
        result = await db.execute(
            select(func.count(VerificationCode.id)).where(
                VerificationCode.uid == uid,
                VerificationCode.created_at >= since,
            )
        )
        return int(result.scalar() or 0)

    async def void_recent_unused(
        self,
        db: AsyncSession,
        *,
        target: str,
        purpose: str,
    ) -> None:
        """Mark all unused codes for target+purpose as used.

        Called when a new code is issued for the same target so that only
        the latest code is valid.
        """
        now = datetime.now(timezone.utc)
        await db.execute(
            update(VerificationCode)
            .where(
                VerificationCode.target == target,
                VerificationCode.purpose == purpose,
                VerificationCode.used.is_(False),
            )
            .values(used=True)
        )
        logger.debug(
            "[VC_REPO] voided unused codes target=%s purpose=%s at=%s",
            target, purpose, now,
        )


_vc_repo: Optional[VerificationCodeRepository] = None


def get_verification_code_repository() -> VerificationCodeRepository:
    global _vc_repo
    if _vc_repo is None:
        _vc_repo = VerificationCodeRepository()
    return _vc_repo
