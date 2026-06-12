from typing import Any

import pytest

from app.routers import auth as auth_router


class _FakeBili:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.closed = False

    async def poll_qrcode_status(self, _qrcode_key: str) -> dict[str, Any]:
        return {
            "status": "confirmed",
            "message": "登录成功",
            "cookies": {"SESSDATA": "sess", "DedeUserID": "123"},
            "refresh_token": "refresh",
        }

    async def get_user_info(self) -> dict[str, Any]:
        return {"mid": 123, "uname": "B站用户", "face": "avatar.png"}

    async def close(self) -> None:
        self.closed = True


class _FakeUserService:
    bound: dict[str, Any] | None = None
    ensured = False

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        pass

    async def bind_oauth_to_user(self, **kwargs: Any) -> None:
        type(self).bound = kwargs

    async def ensure_user_from_oauth(self, **_kwargs: Any) -> tuple[int, Any]:
        type(self).ensured = True
        raise AssertionError("binding mode must not create a new app session")

    async def get_user_roles(self, _uid: int) -> list[str]:
        return ["free"]


class _Request:
    headers = {"user-agent": "pytest", "accept-language": "zh-CN"}
    client = None


async def _fake_snowflake() -> None:
    return None


@pytest.mark.asyncio
async def test_qrcode_poll_with_current_token_binds_bilibili_without_switching_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _FakeUserService.bound = None
    _FakeUserService.ensured = False
    monkeypatch.setattr(auth_router, "BilibiliService", _FakeBili)
    monkeypatch.setattr(auth_router, "UserService", _FakeUserService)

    async def fake_validate_token(_db: Any, _token: str) -> int:
        return 42

    monkeypatch.setattr(auth_router, "_validate_token", fake_validate_token)
    monkeypatch.setattr(auth_router, "_get_sf", _fake_snowflake)

    response = await auth_router.poll_qrcode_status(
        "qr-key",
        _Request(),
        db=object(),
        token_str="app-token",
    )

    assert response.status == "confirmed"
    assert response.session_id is None
    assert response.user_info["uid"] == 42
    assert _FakeUserService.ensured is False
    assert _FakeUserService.bound is not None
    assert _FakeUserService.bound["uid"] == 42
    assert _FakeUserService.bound["provider"] == "bilibili"
    assert _FakeUserService.bound["provider_uid"] == "123"


@pytest.mark.asyncio
async def test_qrcode_poll_with_invalid_current_token_does_not_create_new_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _FakeUserService.bound = None
    _FakeUserService.ensured = False
    monkeypatch.setattr(auth_router, "BilibiliService", _FakeBili)
    monkeypatch.setattr(auth_router, "UserService", _FakeUserService)

    async def fake_validate_token(_db: Any, _token: str) -> None:
        return None

    monkeypatch.setattr(auth_router, "_validate_token", fake_validate_token)
    monkeypatch.setattr(auth_router, "_get_sf", _fake_snowflake)

    with pytest.raises(auth_router.HTTPException) as exc:
        await auth_router.poll_qrcode_status(
            "qr-key",
            _Request(),
            db=object(),
            token_str="expired-app-token",
        )

    assert exc.value.status_code == 401
    assert _FakeUserService.ensured is False
    assert _FakeUserService.bound is None


@pytest.mark.asyncio
async def test_qrcode_poll_binding_purpose_requires_current_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _FakeUserService.bound = None
    _FakeUserService.ensured = False
    monkeypatch.setattr(auth_router, "BilibiliService", _FakeBili)
    monkeypatch.setattr(auth_router, "UserService", _FakeUserService)
    monkeypatch.setattr(auth_router, "_get_sf", _fake_snowflake)

    with pytest.raises(auth_router.HTTPException) as exc:
        await auth_router.poll_qrcode_status(
            "qr-key",
            _Request(),
            db=object(),
            token_str=None,
            purpose="bind",
        )

    assert exc.value.status_code == 401
    assert _FakeUserService.ensured is False
    assert _FakeUserService.bound is None
