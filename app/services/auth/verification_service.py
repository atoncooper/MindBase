"""VerificationService — orchestrates verification code lifecycle.

Responsibilities:
  - Generate 6-digit codes (or reset tokens)
  - Persist via VerificationCodeRepository
  - Enforce rate limits (per-target cooldown + per-uid window)
  - Send via EmailService
  - Verify user-supplied codes (single-use, expiry, brute-force cap)
  - Orchestrate multi-step auth flows (change password with 2FA, bind email,
    reset password with token) — owns the transaction boundary for these.

Valid purposes:
  - bind_email     — bind/change email (requires login)
  - reset_password — forgot password flow (public)
  - twofa          — sensitive operation second factor (requires login)

This service does NOT know about HTTP or sessions; it raises ValueError
on business-rule violations and the router converts to HTTPException.

Transaction boundary: standalone write methods (send_code, send_reset_token)
own their transaction via transactional_scope(). Composable methods
(verify_code, consume_code) accept a db and participate in the caller's
transaction. Multi-service orchestration methods own the transaction and
instantiate collaborating services (UserService) with the tx session.
"""
from __future__ import annotations

import secrets
import string
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from loguru import logger
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.infra.transaction import transactional_scope
from app.models import VerificationCode
from app.repository.verification_code_repository import (
    get_verification_code_repository,
)
from app.repository.user_repository import get_user_repository
from app.services.auth.user_service import UserService
from app.services.email_service import send_verification_code, EmailServiceError


VALID_PURPOSES = {"bind_email", "reset_password", "twofa"}


class VerificationService:
    """Stateless orchestration of email verification codes.

    Methods accept db per-call; no instance session state. Standalone
    writes own their transaction; composable methods participate in the
    caller's transaction.
    """

    def __init__(self) -> None:
        self.repo = get_verification_code_repository()

    # ── Send (standalone — owns tx) ────────────────────────────────

    async def send_code(
        self,
        db: AsyncSession,
        *,
        uid: int,
        target: str,
        purpose: str,
    ) -> None:
        """Generate, persist, and email a verification code.

        Rate limits:
          - Same target: at most 1 send per `rate_limit_target_seconds` (default 60s)
          - Same uid: at most `rate_limit_uid_max` sends in
            `rate_limit_uid_minutes` window (default 5 / 10 min)

        Raises ValueError on rate-limit or email failure.
        """
        if purpose not in VALID_PURPOSES:
            raise ValueError(f"无效的验证用途: {purpose}")
        if not target:
            raise ValueError("邮箱不能为空")

        code = _generate_numeric_code(settings.email_code_length)
        async with transactional_scope() as tx_db:
            await self._enforce_rate_limits(tx_db, uid, target)
            # Void any prior unused codes for same target+purpose so only the
            # latest one is valid.
            await self.repo.void_recent_unused(
                tx_db, target=target, purpose=purpose
            )
            await self.repo.create(
                tx_db,
                uid=uid,
                target=target,
                purpose=purpose,
                code=code,
                ttl_seconds=settings.email_code_ttl_seconds,
            )

        # Email send is outside tx — can't roll back, and a sent email with
        # a persisted code is recoverable (user can retry, rate limit gates).
        try:
            await send_verification_code(target, code, purpose)
        except EmailServiceError as e:
            logger.warning(
                "[VERIFY] email send failed uid=%s target=%s purpose=%s err=%s",
                uid, target, purpose, e,
            )
            raise ValueError(str(e)) from e

        logger.info(
            "[VERIFY] code sent uid=%s target=%s purpose=%s",
            uid, target, purpose,
        )

    async def send_reset_token(self, db: AsyncSession, *, target: str) -> None:
        """Public entry: email a reset token to unverified user.

        Looks up uid by email; raises ValueError if no user has that email.
        Uses a 32-byte URL-safe token instead of a 6-digit code so it can
        be embedded in a reset link.
        """
        user = await get_user_repository().find_by_email(target, db)
        if not user:
            # Don't leak whether the email is registered.
            raise ValueError("如果该邮箱已注册，您将收到重置邮件")

        token = secrets.token_urlsafe(32)
        async with transactional_scope() as tx_db:
            await self._enforce_rate_limits(tx_db, user.uid, target)
            await self.repo.void_recent_unused(
                tx_db, target=target, purpose="reset_password"
            )
            # Reset tokens live 10 minutes (longer than 6-digit codes).
            await self.repo.create(
                tx_db,
                uid=user.uid,
                target=target,
                purpose="reset_password",
                code=token,
                ttl_seconds=600,
            )

        try:
            await send_verification_code(target, token, "reset_password")
        except EmailServiceError as e:
            raise ValueError(str(e)) from e

        logger.info(
            "[VERIFY] reset token sent uid=%s target=%s",
            user.uid, target,
        )

    # ── Verify (composable — participates in caller tx) ────────────

    async def verify_code(
        self,
        db: AsyncSession,
        *,
        uid: int,
        target: str,
        purpose: str,
        code: str,
    ) -> int:
        """Verify a user-supplied code WITHOUT consuming it.

        Returns the verification_code.id on success. Caller MUST call
        ``consume_code(db, vc_id)`` after the downstream business operation
        (e.g. password change, email bind) succeeds, so that a failure in
        the business step leaves the code reusable for retry.

        Raises ValueError on:
          - no matching code found (expired or never sent)
          - wrong code (also increments attempt counter)
          - brute-force cap reached (code auto-voided)
        """
        vc = await self.repo.find_latest_unused(
            db, target=target, purpose=purpose
        )
        if vc is None:
            raise ValueError("验证码已过期或未发送，请重新获取")
        if vc.uid != uid:
            # Code was issued to a different uid — treat as invalid.
            raise ValueError("验证码无效")

        if vc.attempts and vc.attempts >= settings.email_max_verify_attempts:
            # Cap reached — void the code so it can't be retried.
            await self.repo.mark_used(db, vc.id)
            logger.warning(
                "[VERIFY] brute-force cap reached target={} purpose={}",
                target, purpose,
            )
            raise ValueError("验证码错误次数过多，请重新获取")

        if vc.code != code:
            attempts = await self.repo.increment_attempts(db, vc.id)
            logger.info(
                "[VERIFY] wrong code target={} purpose={} attempts={}",
                target, purpose, attempts,
            )
            raise ValueError("验证码不正确")

        logger.info(
            "[VERIFY] ok (not yet consumed) uid={} target={} purpose={} vc_id={}",
            uid, target, purpose, vc.id,
        )
        return vc.id

    async def consume_code(self, db: AsyncSession, vc_id: int) -> None:
        """Mark a verified code as used. Call this only AFTER the downstream
        business operation (password change, email bind, etc.) succeeds."""
        await self.repo.mark_used(db, vc_id)
        logger.info("[VERIFY] consumed vc_id={}", vc_id)

    async def verify_reset_token(
        self, db: AsyncSession, *, token: str
    ) -> int:
        """Verify a reset token, return the uid it was issued to.

        Public entry — caller is responsible for enforcing that the token
        came from an email link (not user-supplied without proof).
        """
        now = datetime.now(timezone.utc)
        result = await db.execute(
            select(VerificationCode)
            .where(
                VerificationCode.purpose == "reset_password",
                VerificationCode.code == token,
                VerificationCode.used.is_(False),
                VerificationCode.expires_at > now,
            )
            .order_by(VerificationCode.created_at.desc())
            .limit(1)
        )
        vc = result.scalar_one_or_none()
        if vc is None:
            raise ValueError("重置链接无效或已过期")
        return vc.uid

    async def consume_reset_token(
        self, db: AsyncSession, *, token: str
    ) -> int:
        """Verify + mark used. Returns uid for the caller to update password."""
        uid = await self.verify_reset_token(db, token=token)
        await db.execute(
            update(VerificationCode)
            .where(
                VerificationCode.code == token,
                VerificationCode.purpose == "reset_password",
            )
            .values(used=True)
        )
        return uid

    # ── Multi-service orchestration (owns tx) ──────────────────────

    async def verify_and_change_password(
        self,
        db: AsyncSession,
        *,
        uid: int,
        old_password: str,
        new_password: str,
        email_code: Optional[str],
        sf: Any,
    ) -> None:
        """Change password with optional 2FA verification.

        If the user has a verified email, requires an email_code (2FA).
        Verifies code → changes password → consumes code, atomically.
        """
        async with transactional_scope() as tx_db:
            user = await get_user_repository().get_by_uid(uid, tx_db)
            vc_id: Optional[int] = None
            if user and user.email_verified and user.email:
                if not email_code:
                    raise ValueError("修改密码需要邮箱验证码")
                vc_id = await self.verify_code(
                    tx_db,
                    uid=uid,
                    target=user.email,
                    purpose="twofa",
                    code=email_code,
                )
            user_service = UserService(tx_db, sf)
            await user_service.change_password(uid, old_password, new_password)
            if vc_id is not None:
                await self.consume_code(tx_db, vc_id)

    async def verify_and_bind_email(
        self,
        db: AsyncSession,
        *,
        uid: int,
        email: str,
        code: str,
        purpose: str,
        sf: Any,
    ) -> None:
        """Verify email code and bind email (purpose=bind_email), or just
        verify (purpose=twofa). Atomically verifies → binds → consumes."""
        async with transactional_scope() as tx_db:
            vc_id = await self.verify_code(
                tx_db, uid=uid, target=email, purpose=purpose, code=code,
            )
            if purpose == "bind_email":
                user_service = UserService(tx_db, sf)
                await user_service.apply_verified_email(uid, email)
            # Consume the code only after the downstream bind succeeds.
            await self.consume_code(tx_db, vc_id)

    async def consume_token_and_reset_password(
        self,
        db: AsyncSession,
        *,
        token: str,
        new_password: str,
        sf: Any,
    ) -> None:
        """Consume reset token and reset password, atomically."""
        async with transactional_scope() as tx_db:
            uid = await self.consume_reset_token(tx_db, token=token)
            user_service = UserService(tx_db, sf)
            await user_service.reset_password(uid, new_password)

    # ── Rate limit enforcement ────────────────────────────────────

    async def _enforce_rate_limits(
        self, db: AsyncSession, uid: int, target: str
    ) -> None:
        """Raise ValueError if rate limits would be exceeded."""
        now = datetime.now(timezone.utc)

        # Per-target cooldown: latest code within N seconds blocks new sends.
        recent_target_count = await self.repo.count_recent_by_target(
            db,
            target=target,
            since=now - timedelta(seconds=settings.email_rate_limit_target_seconds),
        )
        if recent_target_count > 0:
            raise ValueError(
                f"请求过于频繁，请 {settings.email_rate_limit_target_seconds} 秒后重试"
            )

        # Per-uid window: at most N sends in M minutes.
        recent_uid_count = await self.repo.count_recent_by_uid(
            db,
            uid=uid,
            since=now - timedelta(minutes=settings.email_rate_limit_uid_minutes),
        )
        if recent_uid_count >= settings.email_rate_limit_uid_max:
            raise ValueError(
                "请求过于频繁，请稍后重试"
            )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _generate_numeric_code(length: int) -> str:
    """Cryptographically-random numeric code (avoids 0/O ambiguity not needed
    because it's all digits)."""
    alphabet = string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))
