"""WeChat QR login (open platform snsapi_login) tests — state helpers,
service error mapping, router gate/flow with mocked WeChat OpenAPI, and a
real-DB pass over ensure_user_from_oauth (union_id persistence +
idempotency). Follows test_auth_bilibili_binding.py mocking conventions.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
import pytest_asyncio
from fastapi import HTTPException

from app.infra import config as infra_config
from app.infra import redis as redis_mod
from app.routers import auth as auth_router
from app.services.auth import wechat_service
from app.services.auth.user_service import UserService
from app.services.auth.security import decrypt, encrypt
from app.utils.snowflake import SnowflakeGenerator

_FALLBACK_REDIS_URLS = [
    "redis://:mind-base@localhost:6379/0",
    "redis://localhost:6379/0",
]


async def _init_redis() -> bool:
    if redis_mod.is_enabled():
        return True
    original_url = infra_config.config.redis.url
    for url in dict.fromkeys([original_url, *_FALLBACK_REDIS_URLS]):
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
    original_url = infra_config.config.redis.url
    ok = await _init_redis()
    if not ok:
        pytest.skip("Redis unavailable — wechat state tests skipped")
    yield
    await redis_mod.close()
    infra_config.config.redis.url = original_url


_ENABLED_SETTINGS = SimpleNamespace(
    wechat_enabled=True,
    wechat_app_id="wx-test-appid",
    wechat_app_secret="test-secret",
    wechat_redirect_uri="http://localhost:3000/oauth/wechat/callback",
)


class _Request:
    headers = {"user-agent": "pytest", "accept-language": "zh-CN"}
    client = None


class _FakeTxScope:
    async def __aenter__(self) -> Any:
        return object()

    async def __aexit__(self, *_a: Any) -> bool:
        return False


class _FakeWeChatService:
    exchange_payload = {
        "openid": "oX-test-openid",
        "unionid": "uni-test",
        "access_token": "at-test",
        "refresh_token": "rt-test",
        "expires_in": 7200,
    }

    async def exchange_code(self, _code: str) -> dict:
        return dict(type(self).exchange_payload)

    async def get_user_info(self, _at: str, _openid: str) -> dict:
        return {"nickname": "测试微信用户", "headimgurl": "https://wx.qlogo.cn/m/0"}


class _FakeUserService:
    last_kwargs: dict | None = None

    def __init__(self, *_a: Any, **_k: Any) -> None:
        pass

    async def ensure_user_from_oauth(self, **kwargs: Any) -> tuple[int, Any]:
        type(self).last_kwargs = kwargs
        return 1001, SimpleNamespace(session_token="tok-wechat", expires_at=None)

    async def get_user_by_uid(self, uid: int) -> dict:
        return {"uid": uid, "nickname": "测试微信用户", "avatar": "a", "status": "active"}

    async def get_user_roles(self, _uid: int) -> list[str]:
        return ["free"]


async def _fake_sf() -> SnowflakeGenerator:
    return SnowflakeGenerator(worker_id=99)


def _patch_login_flow(monkeypatch: pytest.MonkeyPatch, *, state_ok: bool = True) -> None:
    monkeypatch.setattr(auth_router, "settings", _ENABLED_SETTINGS)
    monkeypatch.setattr(auth_router, "transactional_scope", lambda: _FakeTxScope())
    monkeypatch.setattr(auth_router, "UserService", _FakeUserService)
    monkeypatch.setattr(auth_router, "_get_sf", _fake_sf)
    monkeypatch.setattr(wechat_service, "WeChatService", _FakeWeChatService)

    async def _consume(_state: str | None, _purpose: str) -> bool:
        return state_ok

    monkeypatch.setattr(wechat_service, "consume_state", _consume)


# ── State helpers (Redis) ────────────────────────────────────────


@pytest.mark.asyncio
async def test_state_round_trip_single_use(live_redis: None) -> None:
    state = await wechat_service.issue_state(wechat_service.STATE_LOGIN)
    assert state
    assert await wechat_service.consume_state(state, wechat_service.STATE_LOGIN) is True
    # Replay rejected — one-time consumption.
    assert await wechat_service.consume_state(state, wechat_service.STATE_LOGIN) is False


@pytest.mark.asyncio
async def test_state_purpose_binding(live_redis: None) -> None:
    state = await wechat_service.issue_state(wechat_service.STATE_LOGIN)
    assert await wechat_service.consume_state(state, wechat_service.STATE_BIND) is False
    bind_state = await wechat_service.issue_state(wechat_service.STATE_BIND)
    assert await wechat_service.consume_state(bind_state, wechat_service.STATE_BIND) is True


@pytest.mark.asyncio
async def test_consume_state_invalid_inputs(live_redis: None) -> None:
    assert await wechat_service.consume_state(None, wechat_service.STATE_LOGIN) is False
    assert await wechat_service.consume_state("no-such-state", wechat_service.STATE_LOGIN) is False


# ── Service error mapping ────────────────────────────────────────


def test_check_errcode_raises_on_error():
    with pytest.raises(wechat_service.WeChatServiceError):
        wechat_service._check_errcode(
            {"errcode": 40029, "errmsg": "invalid code"}, action="t"
        )


def test_check_errcode_passes_without_error():
    wechat_service._check_errcode({"openid": "x"}, action="t")


# ── Router: GET /auth/wechat/qrcode ──────────────────────────────


@pytest.mark.asyncio
async def test_qrcode_endpoint_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        auth_router,
        "settings",
        SimpleNamespace(wechat_enabled=False),
    )
    resp = await auth_router.get_wechat_qrcode(purpose=None, token_str=None, db=object())
    assert resp.enabled is False
    assert resp.state == ""


@pytest.mark.asyncio
async def test_qrcode_endpoint_issues_login_state(
    live_redis: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(auth_router, "settings", _ENABLED_SETTINGS)
    resp = await auth_router.get_wechat_qrcode(purpose=None, token_str=None, db=object())
    assert resp.enabled is True
    assert resp.app_id == "wx-test-appid"
    assert resp.redirect_uri.endswith("/oauth/wechat/callback")
    assert await wechat_service.consume_state(resp.state, wechat_service.STATE_LOGIN) is True


@pytest.mark.asyncio
async def test_qrcode_bind_purpose_requires_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth_router, "settings", _ENABLED_SETTINGS)
    with pytest.raises(HTTPException) as excinfo:
        await auth_router.get_wechat_qrcode(purpose="bind", token_str=None, db=object())
    assert excinfo.value.status_code == 401


# ── Router: POST /auth/wechat/login ──────────────────────────────


@pytest.mark.asyncio
async def test_wechat_login_creates_user_and_returns_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _FakeUserService.last_kwargs = None
    _patch_login_flow(monkeypatch)

    resp = await auth_router.login_with_wechat(
        auth_router.WeChatLoginRequest(code="code-1", state="state-1"), _Request()
    )

    assert resp.session_token == "tok-wechat"
    assert resp.user_info.uid == 1001
    assert resp.user_info.nickname == "测试微信用户"
    assert resp.user_info.roles == ["free"]

    kwargs = _FakeUserService.last_kwargs
    assert kwargs["provider"] == "wechat"
    assert kwargs["provider_uid"] == "oX-test-openid"
    assert kwargs["provider_data"]["union_id"] == "uni-test"
    assert kwargs["profile"] == {"nickname": "测试微信用户", "avatar": "https://wx.qlogo.cn/m/0"}


@pytest.mark.asyncio
async def test_wechat_login_rejects_expired_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_login_flow(monkeypatch, state_ok=False)
    with pytest.raises(HTTPException) as excinfo:
        await auth_router.login_with_wechat(
            auth_router.WeChatLoginRequest(code="c", state="s"), _Request()
        )
    assert excinfo.value.status_code == 400
    assert "过期" in excinfo.value.detail


@pytest.mark.asyncio
async def test_wechat_login_maps_exchange_error_to_502(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_login_flow(monkeypatch)

    class _BrokenWeChat:
        async def exchange_code(self, _code: str) -> dict:
            raise wechat_service.WeChatServiceError("微信登录服务暂不可用，请稍后重试")

        async def get_user_info(self, _at: str, _openid: str) -> dict:
            return {}

    monkeypatch.setattr(wechat_service, "WeChatService", _BrokenWeChat)
    with pytest.raises(HTTPException) as excinfo:
        await auth_router.login_with_wechat(
            auth_router.WeChatLoginRequest(code="c", state="s"), _Request()
        )
    assert excinfo.value.status_code == 502


@pytest.mark.asyncio
async def test_wechat_login_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        auth_router, "settings", SimpleNamespace(wechat_enabled=False)
    )
    with pytest.raises(HTTPException) as excinfo:
        await auth_router.login_with_wechat(
            auth_router.WeChatLoginRequest(code="c", state="s"), _Request()
        )
    assert excinfo.value.status_code == 400


# ── Router: POST /auth/wechat/bind ───────────────────────────────


@pytest.mark.asyncio
async def test_wechat_bind_calls_bind_oauth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bound: dict[str, Any] = {}

    class _BindUserService:
        def __init__(self, *_a: Any, **_k: Any) -> None:
            pass

        async def bind_oauth_to_user(self, **kwargs: Any) -> None:
            bound.update(kwargs)

    _patch_login_flow(monkeypatch)
    monkeypatch.setattr(auth_router, "UserService", _BindUserService)

    resp = await auth_router.bind_wechat(
        auth_router.WeChatLoginRequest(code="c", state="s"), uid=42
    )
    assert resp["message"] == "微信账号绑定成功"
    assert bound["uid"] == 42
    assert bound["provider"] == "wechat"
    assert bound["provider_uid"] == "oX-test-openid"


# ── Real DB: ensure_user_from_oauth persists union_id + idempotent ─


@pytest.mark.asyncio
async def test_ensure_user_from_oauth_wechat_union_id_and_idempotency(test_db) -> None:
    from app.repository.user_oauth_repository import get_user_oauth_repository

    service = UserService(test_db, SnowflakeGenerator(worker_id=98))
    provider_data = {
        "access_token": "at-real",
        "refresh_token": "rt-real",
        "union_id": "uni-real",
        "raw_data": '{"openid": "oX-real"}',
    }

    uid1, token1 = await service.ensure_user_from_oauth(
        provider="wechat",
        provider_uid="oX-real",
        provider_data=provider_data,
        profile={"nickname": "真实微信用户", "avatar": "https://wx.qlogo.cn/r"},
    )
    assert token1.session_token

    # Second login with the same openid → same uid, fresh token.
    uid2, token2 = await service.ensure_user_from_oauth(
        provider="wechat",
        provider_uid="oX-real",
        provider_data=provider_data,
    )
    assert uid2 == uid1
    assert token2.session_token != token1.session_token

    record = await get_user_oauth_repository().find_by_provider(
        "wechat", "oX-real", test_db
    )
    assert record is not None
    assert record.union_id == "uni-real"
    assert record.is_primary is True
    assert decrypt(record.access_token) == "at-real"
    assert encrypt("at-real")  # encryption path exercised (dev fallback or AES)

    info = await service.get_user_by_uid(uid1)
    assert info["nickname"] == "真实微信用户"
    assert "free" in info["roles"]
