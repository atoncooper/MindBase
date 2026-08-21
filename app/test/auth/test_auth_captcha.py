"""Captcha (graphical, anti-bot) tests — service + router gate.

Redis-dependent tests try the app-configured Redis first and fall back to
localhost candidates (host-side runs where .env points at the Docker
network hostname). They skip when no Redis is reachable.
"""

from __future__ import annotations

import base64
import secrets
from types import SimpleNamespace
from typing import Any

import pytest
import pytest_asyncio
from fastapi import HTTPException

from app.config import settings
from app.infra import config as infra_config
from app.infra import redis as redis_mod
from app.routers import auth as auth_router
from app.services.auth.captcha_service import (
    _digest,
    _captcha_key,
    _render_code,
    generate_captcha,
    verify_captcha,
)

_FALLBACK_REDIS_URLS = [
    "redis://:mind-base@localhost:6379/0",
    "redis://localhost:6379/0",
]


async def _init_redis() -> bool:
    if redis_mod.is_enabled():
        return True
    original_url = infra_config.config.redis.url
    candidates = [original_url, *_FALLBACK_REDIS_URLS]
    for url in dict.fromkeys(candidates):  # de-dup, keep order
        if not url:
            continue
        infra_config.config.redis.url = url
        try:
            await redis_mod.init()
            return True
        except Exception:
            await redis_mod.close()
            continue
    infra_config.config.redis.url = original_url
    return False


@pytest_asyncio.fixture()
async def live_redis():
    """Ensure a live Redis connection; skip the test otherwise."""
    original_url = infra_config.config.redis.url
    ok = await _init_redis()
    if not ok:
        pytest.skip("Redis unavailable — captcha round-trip tests skipped")
    yield
    await redis_mod.close()
    infra_config.config.redis.url = original_url


# ── Rendering (no Redis) ─────────────────────────────────────────


def test_render_code_returns_valid_png():
    png = _render_code("AB3D", 160, 56)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert len(png) > 500  # non-trivial image with noise


def test_render_code_produces_distinct_images():
    assert _render_code("AB3D", 160, 56) != _render_code("AB3D", 160, 56)


# ── Service round-trip (Redis) ───────────────────────────────────


@pytest.mark.asyncio
async def test_generate_captcha_shape(live_redis: None) -> None:
    result = await generate_captcha()
    assert result.required is True
    assert result.captcha_id
    assert result.expires_in == settings.captcha_ttl_seconds
    assert result.image_data_url.startswith("data:image/png;base64,")
    png = base64.b64decode(result.image_data_url.split(",", 1)[1])
    assert png[:8] == b"\x89PNG\r\n\x1a\n"


@pytest.mark.asyncio
async def test_verify_captcha_single_use(live_redis: None) -> None:
    captcha_id = secrets.token_urlsafe(16)
    assert redis_mod.client is not None
    await redis_mod.client.set(_captcha_key(captcha_id), _digest("AB3D"), ex=60)

    # Case-insensitive match succeeds and consumes the entry.
    assert await verify_captcha(captcha_id, " ab3d ") is True
    # Second attempt with the same id fails — single use.
    assert await verify_captcha(captcha_id, "AB3D") is False


@pytest.mark.asyncio
async def test_verify_captcha_wrong_code_fails_and_consumes(live_redis: None) -> None:
    captcha_id = secrets.token_urlsafe(16)
    assert redis_mod.client is not None
    await redis_mod.client.set(_captcha_key(captcha_id), _digest("AB3D"), ex=60)

    assert await verify_captcha(captcha_id, "ZZZZ") is False
    # Already consumed by the failed attempt above.
    assert await verify_captcha(captcha_id, "AB3D") is False


@pytest.mark.asyncio
async def test_verify_captcha_missing_fields_rejected(live_redis: None) -> None:
    assert await verify_captcha(None, "AB3D") is False
    assert await verify_captcha("some-id", "") is False
    assert await verify_captcha("unknown-id", "AB3D") is False


@pytest.mark.asyncio
async def test_verify_captcha_disabled_fails_open(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.services.auth.captcha_service.settings",
        SimpleNamespace(captcha_enabled=False),
    )
    assert await verify_captcha(None, None) is True


@pytest.mark.asyncio
async def test_generate_captcha_degraded_when_redis_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(redis_mod, "is_enabled", lambda: False)
    result = await generate_captcha()
    assert result.required is False
    assert result.captcha_id == ""
    assert result.image_data_url == ""


# ── Router gate (_require_captcha) ────────────────────────────────


@pytest.mark.asyncio
async def test_require_captcha_passes_when_verified(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _ok(*_a: Any, **_k: Any) -> bool:
        return True

    monkeypatch.setattr(auth_router, "verify_captcha", _ok)
    await auth_router._require_captcha("id", "CODE", ip="1.2.3.4", endpoint="login")


@pytest.mark.asyncio
async def test_require_captcha_missing_fields_raises_400(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _fail(*_a: Any, **_k: Any) -> bool:
        return False

    monkeypatch.setattr(auth_router, "verify_captcha", _fail)
    with pytest.raises(HTTPException) as excinfo:
        await auth_router._require_captcha(None, None, ip="1.2.3.4", endpoint="login")
    assert excinfo.value.status_code == 400
    assert excinfo.value.detail == "请输入图形验证码"


@pytest.mark.asyncio
async def test_require_captcha_wrong_code_raises_400(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _fail(*_a: Any, **_k: Any) -> bool:
        return False

    monkeypatch.setattr(auth_router, "verify_captcha", _fail)
    with pytest.raises(HTTPException) as excinfo:
        await auth_router._require_captcha(
            "some-id", "BAD", ip="1.2.3.4", endpoint="login"
        )
    assert excinfo.value.status_code == 400
    assert excinfo.value.detail == "图形验证码错误或已过期"


# ── Request schemas carry captcha fields ─────────────────────────


def test_request_models_carry_captcha_fields():
    from app.response import EmailSendCodeRequest, LoginRequest, PasswordResetRequest

    login = LoginRequest(email="a@b.co", password="secret123")
    assert login.captcha_id is None
    assert login.captcha_code is None

    reset = PasswordResetRequest(email="a@b.co", captcha_id="cid", captcha_code="X")
    assert reset.captcha_code == "X"

    send = EmailSendCodeRequest(email="a@b.co", purpose="bind_email", captcha_code="Y")
    assert send.captcha_code == "Y"
