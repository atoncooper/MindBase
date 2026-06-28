"""Tests for rate_limit_deps — FastAPI dependency factories.

Each dep wraps rate_limit_service singleton calls and converts
RateLimitExceeded / LoginCooldown to HTTPException(429) with Retry-After.

We mock the singleton's methods directly to test the translation layer.
The goal is to verify:
  1. dep calls the right service method with right args
  2. exceptions are translated to HTTP 429 with correct Retry-After header
  3. 429 detail differs for LoginCooldown ("账号已被临时锁定")
"""

import pytest
from unittest.mock import AsyncMock, MagicMock

from fastapi import HTTPException

from app.services.auth import rate_limit_deps
from app.services.auth.rate_limit_service import (
    LoginCooldown,
    RateLimitExceeded,
)


def _make_request(ip: str = "1.2.3.4"):
    """Build a mock Request with the given IP."""
    req = MagicMock()
    req.headers.get.return_value = ""
    req.client = MagicMock(host=ip)
    return req


# ── login_rate_limit_dep ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_login_dep_passes_when_all_checks_pass(monkeypatch):
    """No exception → dep returns None silently."""
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_ip", AsyncMock())
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_target", AsyncMock())
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_login_cooldown", AsyncMock())

    from app.response import LoginRequest
    req = LoginRequest(email="alice@example.com", password="secret")
    await rate_limit_deps.login_rate_limit_dep(_make_request(), req, db=MagicMock())


@pytest.mark.asyncio
async def test_login_dep_raises_429_on_ip_limit(monkeypatch):
    """IP rate limit exceeded → HTTP 429 with Retry-After."""
    async def _raise(*args, **kwargs):
        raise RateLimitExceeded(retry_after=60)
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_ip", _raise)
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_target", AsyncMock())
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_login_cooldown", AsyncMock())

    from app.response import LoginRequest
    req = LoginRequest(email="alice@example.com", password="secret")
    with pytest.raises(HTTPException) as exc_info:
        await rate_limit_deps.login_rate_limit_dep(_make_request(), req, db=MagicMock())
    assert exc_info.value.status_code == 429
    assert exc_info.value.headers["Retry-After"] == "60"


@pytest.mark.asyncio
async def test_login_dep_raises_429_on_cooldown(monkeypatch):
    """LoginCooldown → HTTP 429 with account-locked detail message."""
    async def _raise(*args, **kwargs):
        raise LoginCooldown(email="alice@example.com", retry_after=900)
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_ip", AsyncMock())
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_target", AsyncMock())
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_login_cooldown", _raise)

    from app.response import LoginRequest
    req = LoginRequest(email="alice@example.com", password="secret")
    with pytest.raises(HTTPException) as exc_info:
        await rate_limit_deps.login_rate_limit_dep(_make_request(), req, db=MagicMock())
    assert exc_info.value.status_code == 429
    assert "锁定" in exc_info.value.detail
    assert exc_info.value.headers["Retry-After"] == "900"


# ── password_reset_request_rate_limit_dep ──────────────────────────


@pytest.mark.asyncio
async def test_reset_request_dep_passes(monkeypatch):
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_ip", AsyncMock())
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_target", AsyncMock())

    from app.response import PasswordResetRequest
    req = PasswordResetRequest(email="alice@example.com")
    await rate_limit_deps.password_reset_request_rate_limit_dep(
        _make_request(), req, db=MagicMock(),
    )


@pytest.mark.asyncio
async def test_reset_request_dep_raises_429(monkeypatch):
    async def _raise(*args, **kwargs):
        raise RateLimitExceeded(retry_after=3600)
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_ip", _raise)
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_target", AsyncMock())

    from app.response import PasswordResetRequest
    req = PasswordResetRequest(email="alice@example.com")
    with pytest.raises(HTTPException) as exc_info:
        await rate_limit_deps.password_reset_request_rate_limit_dep(
            _make_request(), req, db=MagicMock(),
        )
    assert exc_info.value.status_code == 429
    assert exc_info.value.headers["Retry-After"] == "3600"


# ── password_reset_rate_limit_dep ──────────────────────────────────


@pytest.mark.asyncio
async def test_reset_dep_passes(monkeypatch):
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_ip", AsyncMock())
    await rate_limit_deps.password_reset_rate_limit_dep(_make_request(), db=MagicMock())


@pytest.mark.asyncio
async def test_reset_dep_raises_429(monkeypatch):
    async def _raise(*args, **kwargs):
        raise RateLimitExceeded(retry_after=3600)
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_ip", _raise)
    with pytest.raises(HTTPException) as exc_info:
        await rate_limit_deps.password_reset_rate_limit_dep(_make_request(), db=MagicMock())
    assert exc_info.value.status_code == 429


# ── email_send_code_rate_limit_dep ─────────────────────────────────


@pytest.mark.asyncio
async def test_send_code_dep_passes(monkeypatch):
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_ip", AsyncMock())
    await rate_limit_deps.email_send_code_rate_limit_dep(_make_request(), db=MagicMock())


@pytest.mark.asyncio
async def test_send_code_dep_raises_429(monkeypatch):
    async def _raise(*args, **kwargs):
        raise RateLimitExceeded(retry_after=60)
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_ip", _raise)
    with pytest.raises(HTTPException) as exc_info:
        await rate_limit_deps.email_send_code_rate_limit_dep(_make_request(), db=MagicMock())
    assert exc_info.value.status_code == 429
    assert exc_info.value.headers["Retry-After"] == "60"


@pytest.mark.asyncio
async def test_send_code_uid_rate_limit_passes(monkeypatch):
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_uid", AsyncMock())
    await rate_limit_deps.send_code_uid_rate_limit(uid=42, db=MagicMock())


@pytest.mark.asyncio
async def test_send_code_uid_rate_limit_raises_429(monkeypatch):
    async def _raise(*args, **kwargs):
        raise RateLimitExceeded(retry_after=600)
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_uid", _raise)
    with pytest.raises(HTTPException) as exc_info:
        await rate_limit_deps.send_code_uid_rate_limit(uid=42, db=MagicMock())
    assert exc_info.value.status_code == 429
    assert exc_info.value.headers["Retry-After"] == "600"


# ── change_password_rate_limit_dep_inline ──────────────────────────


@pytest.mark.asyncio
async def test_change_password_dep_passes(monkeypatch):
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_uid", AsyncMock())
    await rate_limit_deps.change_password_rate_limit_dep_inline(uid=42, db=MagicMock())


@pytest.mark.asyncio
async def test_change_password_dep_raises_429(monkeypatch):
    async def _raise(*args, **kwargs):
        raise RateLimitExceeded(retry_after=3600)
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_uid", _raise)
    with pytest.raises(HTTPException) as exc_info:
        await rate_limit_deps.change_password_rate_limit_dep_inline(uid=42, db=MagicMock())
    assert exc_info.value.status_code == 429
    assert exc_info.value.headers["Retry-After"] == "3600"


# ── email_verify_rate_limit_dep ────────────────────────────────────


@pytest.mark.asyncio
async def test_verify_dep_passes(monkeypatch):
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_ip", AsyncMock())
    await rate_limit_deps.email_verify_rate_limit_dep(_make_request(), db=MagicMock())


@pytest.mark.asyncio
async def test_verify_dep_raises_429(monkeypatch):
    async def _raise(*args, **kwargs):
        raise RateLimitExceeded(retry_after=60)
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_ip", _raise)
    with pytest.raises(HTTPException) as exc_info:
        await rate_limit_deps.email_verify_rate_limit_dep(_make_request(), db=MagicMock())
    assert exc_info.value.status_code == 429
    assert exc_info.value.headers["Retry-After"] == "60"


# ── Detail message differs for cooldown vs plain rate limit ────────


@pytest.mark.asyncio
async def test_cooldown_detail_differs_from_rate_limit(monkeypatch):
    """LoginCooldown detail should mention 临时锁定; plain RateLimitExceeded should not."""
    # Plain rate limit
    async def _raise_plain(*args, **kwargs):
        raise RateLimitExceeded(retry_after=60)
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_ip", _raise_plain)
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_target", AsyncMock())
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_login_cooldown", AsyncMock())

    from app.response import LoginRequest
    req = LoginRequest(email="a@x.com", password="x")
    with pytest.raises(HTTPException) as exc_info:
        await rate_limit_deps.login_rate_limit_dep(_make_request(), req, db=MagicMock())
    plain_detail = exc_info.value.detail
    assert "锁定" not in plain_detail

    # Cooldown
    async def _raise_cooldown(*args, **kwargs):
        raise LoginCooldown(email="a@x.com", retry_after=900)
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_ip", AsyncMock())
    monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_login_cooldown", _raise_cooldown)

    with pytest.raises(HTTPException) as exc_info:
        await rate_limit_deps.login_rate_limit_dep(_make_request(), req, db=MagicMock())
    assert "锁定" in exc_info.value.detail
