"""RateLimitService — Redis-backed rate limiting + DB-backed login cooldown.

Design: 模块级饿汉单例。db 按调用传入（每请求独立 session），
配置在方法内读 settings（支持热更新），不持有任何 per-request 状态。

Responsibilities:
  - check_ip / check_target / check_uid: Redis 固定窗口限流（Lua INCR）
  - check_login_cooldown: DB 查询失败计数，超阈值则冷却
  - record_login_attempt: 持久化登录尝试（成功/失败）
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.infra import redis as redis_mod
from app.infra.transaction import transactional_scope
from app.repository.login_attempt_repository import (
    get_login_attempt_repository,
)


class RateLimitExceeded(Exception):
    """Raised when a rate-limit budget is exhausted.

    `retry_after` is in seconds (for the Retry-After HTTP header).
    """

    def __init__(self, *, retry_after: int) -> None:
        self.retry_after = retry_after
        super().__init__(f"rate limit exceeded (retry_after={retry_after}s)")


class LoginCooldown(Exception):
    """Raised when an email is in login-cooldown due to repeated failures."""

    def __init__(self, *, email: str, retry_after: int) -> None:
        self.email = email
        self.retry_after = retry_after
        super().__init__(f"login cooldown for {email}")


class RateLimitService:
    """Stateless singleton. db passed per-call, config read per-call."""

    def __init__(self) -> None:
        self.repo = get_login_attempt_repository()

    # ── Redis fixed-window checks ─────────────────────────────────

    async def _redis_check(
        self,
        *,
        key: str,
        max_count: int,
        window_sec: int,
    ) -> None:
        """Run Redis INCR-based fixed-window check; raise if over budget."""
        if not redis_mod.is_enabled():
            # Fail open — nginx is the first line of defense.
            logger.debug("[RATELIMIT] redis disabled, allowing key={}", key)
            return
        try:
            allowed = await redis_mod.rate_limit(key, max_count, window_sec)
        except Exception as e:
            logger.warning("[RATELIMIT] redis error, fail-open key={} err={}", key, e)
            return
        if not allowed:
            logger.warning(
                "[RATELIMIT] blocked key={} max={} window={}s",
                key, max_count, window_sec,
            )
            raise RateLimitExceeded(retry_after=window_sec)

    async def check_ip(
        self,
        db: AsyncSession,
        *,
        endpoint: str,
        ip: str,
        max_count: int,
        window_sec: int,
    ) -> None:
        key = f"rl:{endpoint}:ip:{ip}"
        await self._redis_check(key=key, max_count=max_count, window_sec=window_sec)

    async def check_target(
        self,
        db: AsyncSession,
        *,
        endpoint: str,
        target: str,
        max_count: int,
        window_sec: int,
    ) -> None:
        key = f"rl:{endpoint}:target:{target}"
        await self._redis_check(key=key, max_count=max_count, window_sec=window_sec)

    async def check_uid(
        self,
        db: AsyncSession,
        *,
        endpoint: str,
        uid: int,
        max_count: int,
        window_sec: int,
    ) -> None:
        key = f"rl:{endpoint}:uid:{uid}"
        await self._redis_check(key=key, max_count=max_count, window_sec=window_sec)

    # ── Login cooldown (DB-backed) ─────────────────────────────────

    async def check_login_cooldown(
        self,
        db: AsyncSession,
        *,
        email: str,
    ) -> None:
        """Raise LoginCooldown if email has too many recent failures."""
        cooldown_sec = settings.rl_login_cooldown_seconds
        threshold = settings.rl_login_cooldown_threshold
        since = datetime.now(timezone.utc) - timedelta(seconds=cooldown_sec)
        failures = await self.repo.count_recent_failures_by_email(
            db, email=email, since=since,
        )
        if failures >= threshold:
            logger.warning(
                "[RATELIMIT] login cooldown email={} failures={} threshold={}",
                email, failures, threshold,
            )
            raise LoginCooldown(email=email, retry_after=cooldown_sec)

    # ── Attempt recording ──────────────────────────────────────────

    async def record_login_attempt(
        self,
        db: AsyncSession,
        *,
        uid: Optional[int],
        email: Optional[str],
        ip: str,
        device_id: Optional[str],
        success: bool,
        failure_reason: Optional[str] = None,
    ) -> None:
        """Persist a login attempt row. Best-effort — errors are logged.

        Owns its own transaction so callers don't need to wrap. The `db`
        arg is accepted for API symmetry but a fresh tx session is used
        internally to keep audit logging independent of the caller's tx.
        """
        _ = db  # caller session unused — audit writes use own tx
        try:
            async with transactional_scope() as tx_db:
                await self.repo.create(
                    tx_db,
                    uid=uid,
                    email=email,
                    ip=ip,
                    device_id=device_id,
                    success=success,
                    failure_reason=failure_reason,
                )
        except Exception as e:
            logger.warning(
                "[RATELIMIT] failed to record login attempt ip={} email={} err={}",
                ip, email, e,
            )


# 模块级饿汉单例：__init__ 只持有另一个单例引用，无 IO，无运行时配置依赖。
# db 在每个方法调用时传入，保证请求间 session 隔离。
rate_limit_service = RateLimitService()
