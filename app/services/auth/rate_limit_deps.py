"""FastAPI dependency factories for rate-limiting auth endpoints.

Uses the module-level singleton `rate_limit_service`. db is passed
per-call so each request gets its own AsyncSession.

Usage in router:

    @router.post("/login")
    async def login_with_password(
        req: LoginRequest,
        request: Request,
        _rl: None = Depends(login_rate_limit_dep),
    ):
        ...
"""
from __future__ import annotations

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.utils.request_meta import get_client_ip
from app.response import (
    LoginRequest,
)
from app.services.auth.rate_limit_service import (
    LoginCooldown,
    RateLimitExceeded,
    rate_limit_service,
)


def _retry_after_header(retry_after: int) -> dict[str, str]:
    return {"Retry-After": str(retry_after)}


def _raise_429(retry_after: int, detail: str = "请求过于频繁，请稍后重试") -> None:
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=detail,
        headers=_retry_after_header(retry_after),
    )


# ── /auth/login ────────────────────────────────────────────────────


async def login_rate_limit_dep(
    request: Request,
    req: LoginRequest,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Combined per-IP + per-email + DB cooldown check for /auth/login."""
    ip = get_client_ip(request)
    try:
        await rate_limit_service.check_ip(
            db,
            endpoint="login",
            ip=ip,
            max_count=settings.rl_login_ip_max,
            window_sec=settings.rl_login_ip_window,
        )
        await rate_limit_service.check_target(
            db,
            endpoint="login",
            target=req.email,
            max_count=settings.rl_login_email_max,
            window_sec=settings.rl_login_email_window,
        )
        await rate_limit_service.check_login_cooldown(db, email=req.email)
    except RateLimitExceeded as e:
        _raise_429(e.retry_after)
    except LoginCooldown as e:
        _raise_429(e.retry_after, detail="账号已被临时锁定，请稍后重试")


# ── /auth/password/reset-request ───────────────────────────────────


async def password_reset_request_rate_limit_dep(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Per-IP limiter for reset-request. Per-email is done by the router
    inline via ``password_reset_request_email_rate_limit()``.

    Do NOT declare the request body (e.g. ``req: PasswordResetRequest``)
    here: a bare Pydantic-model param is treated as a second body field,
    colliding with the route's ``body`` and making FastAPI wrap the body
    into ``{req, body}`` (HTTP 422 for callers sending ``{email}``).
    """
    ip = get_client_ip(request)
    try:
        await rate_limit_service.check_ip(
            db,
            endpoint="pw_reset_req",
            ip=ip,
            max_count=settings.rl_reset_request_ip_max,
            window_sec=settings.rl_reset_request_ip_window,
        )
    except RateLimitExceeded as e:
        _raise_429(e.retry_after)


async def password_reset_request_email_rate_limit(
    email: str, db: AsyncSession
) -> None:
    """Per-email limiter for reset-request. Called by the router inline
    (mirrors ``send_code_uid_rate_limit`` / ``change_password_rate_limit_dep_inline``).
    """
    try:
        await rate_limit_service.check_target(
            db,
            endpoint="pw_reset_req",
            target=email,
            max_count=settings.rl_reset_request_email_max,
            window_sec=settings.rl_reset_request_email_window,
        )
    except RateLimitExceeded as e:
        _raise_429(e.retry_after)


# ── /auth/password/reset ───────────────────────────────────────────


async def password_reset_rate_limit_dep(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> None:
    ip = get_client_ip(request)
    try:
        await rate_limit_service.check_ip(
            db,
            endpoint="pw_reset",
            ip=ip,
            max_count=settings.rl_reset_ip_max,
            window_sec=settings.rl_reset_ip_window,
        )
    except RateLimitExceeded as e:
        _raise_429(e.retry_after)


# ── /auth/email/send-code ──────────────────────────────────────────


async def email_send_code_rate_limit_dep(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Per-IP limiter for send-code. Per-uid is done by the router inline
    via `send_code_uid_rate_limit()` (avoids circular import with auth.py)."""
    ip = get_client_ip(request)
    try:
        await rate_limit_service.check_ip(
            db,
            endpoint="email_send",
            ip=ip,
            max_count=settings.rl_send_code_ip_max,
            window_sec=settings.rl_send_code_ip_window,
        )
    except RateLimitExceeded as e:
        _raise_429(e.retry_after)


async def send_code_uid_rate_limit(uid: int, db: AsyncSession) -> None:
    """Per-uid limiter for send-code. Called by router inline."""
    try:
        await rate_limit_service.check_uid(
            db,
            endpoint="email_send",
            uid=uid,
            max_count=settings.rl_send_code_uid_max,
            window_sec=settings.rl_send_code_uid_window,
        )
    except RateLimitExceeded as e:
        _raise_429(e.retry_after)


# ── /auth/password (PATCH) ─────────────────────────────────────────


async def change_password_rate_limit_dep_inline(uid: int, db: AsyncSession) -> None:
    """Per-uid limiter for password change. Called by router inline.

    Not a FastAPI Depends (would need get_current_uid → circular import).
    """
    try:
        await rate_limit_service.check_uid(
            db,
            endpoint="pw_change",
            uid=uid,
            max_count=settings.rl_change_password_uid_max,
            window_sec=settings.rl_change_password_uid_window,
        )
    except RateLimitExceeded as e:
        _raise_429(e.retry_after)


# ── /auth/email/verify ─────────────────────────────────────────────


async def email_verify_rate_limit_dep(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> None:
    ip = get_client_ip(request)
    try:
        await rate_limit_service.check_ip(
            db,
            endpoint="email_verify",
            ip=ip,
            max_count=settings.rl_email_verify_ip_max,
            window_sec=settings.rl_email_verify_ip_window,
        )
    except RateLimitExceeded as e:
        _raise_429(e.retry_after)
