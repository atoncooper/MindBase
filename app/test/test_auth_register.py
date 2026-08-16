"""Email self-registration + phone SMS-code login tests.

Follows test_auth_bilibili_binding.py conventions: router functions called
directly with a fake Request, transactional_scope / captcha / snowflake
monkeypatched onto in-memory SQLite (test_db), and email/SMS delivery
mocked at the verification_service namespace.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.config import settings
from app.routers import auth as auth_router
from app.repository.verification_code_repository import (
    get_verification_code_repository,
)
from app.response import (
    LoginRequest,
    PhoneSendCodeRequest,
    PhoneLoginRequest,
    RegisterRequest,
    RegisterSendCodeRequest,
)
from app.services.auth import verification_service
from app.services.auth.user_service import UserService
from app.utils.snowflake import SnowflakeGenerator


class _Request:
    headers = {"user-agent": "pytest", "accept-language": "zh-CN"}
    client = None


class _FakeTxScope:
    def __init__(self, db: Any) -> None:
        self._db = db

    async def __aenter__(self) -> Any:
        return self._db

    async def __aexit__(self, *_a: Any) -> bool:
        return False


async def _fake_sf() -> SnowflakeGenerator:
    return SnowflakeGenerator(worker_id=97)


def _patch_common(monkeypatch: pytest.MonkeyPatch, db: Any, *, sms: bool = False) -> dict:
    """Patch captcha, transaction scopes, snowflake and delivery channels.

    Returns a dict capturing the last delivered code per channel."""
    sent: dict[str, str] = {}

    async def _captcha_ok(*_a: Any, **_k: Any) -> bool:
        return True

    async def _email_ok(_to: str, code: str, _purpose: str) -> None:
        sent["email_code"] = code

    async def _sms_ok(_phone: str, code: str) -> None:
        sent["sms_code"] = code

    monkeypatch.setattr(auth_router, "verify_captcha", _captcha_ok)
    monkeypatch.setattr(auth_router, "transactional_scope", lambda: _FakeTxScope(db))
    monkeypatch.setattr(
        verification_service, "transactional_scope", lambda: _FakeTxScope(db)
    )
    monkeypatch.setattr(auth_router, "_get_sf", _fake_sf)
    monkeypatch.setattr(
        verification_service, "send_verification_code", _email_ok
    )
    if sms:
        monkeypatch.setattr(verification_service, "send_sms_code", _sms_ok)
    return sent


async def _latest_code(db: Any, target: str, purpose: str) -> str:
    vc = await get_verification_code_repository().find_latest_unused(
        db, target=target, purpose=purpose
    )
    assert vc is not None, f"no code persisted for {target}/{purpose}"
    return vc.code


# ── Schema validation ────────────────────────────────────────────


def test_normalize_phone_variants():
    from app.response.auth import normalize_phone

    assert normalize_phone("13800138000") == "13800138000"
    assert normalize_phone("+86 138-0013-8000") == "13800138000"
    assert normalize_phone("008613900139000") == "13900139000"
    with pytest.raises(ValueError):
        normalize_phone("12345678901")  # 不合法号段
    with pytest.raises(ValueError):
        normalize_phone("1380013800")  # 10 位
    with pytest.raises(ValueError):
        normalize_phone("")


def test_login_request_requires_exactly_one_identifier():
    with pytest.raises(ValueError):
        LoginRequest(password="abc12345")
    with pytest.raises(ValueError):
        LoginRequest(email="a@b.co", phone="13800138000", password="abc12345")
    req = LoginRequest(phone="+8613800138000", password="abc12345")
    assert req.phone == "13800138000" and req.email is None


def test_phone_send_code_request_purpose_validation():
    with pytest.raises(ValueError):
        PhoneSendCodeRequest(phone="13800138000", purpose="evil")
    assert PhoneSendCodeRequest(phone="13800138000").purpose == "login"


# ── Email registration flow ──────────────────────────────────────


@pytest.mark.asyncio
async def test_register_email_full_flow(test_db, monkeypatch: pytest.MonkeyPatch) -> None:
    sent = _patch_common(monkeypatch, test_db)
    email = "newuser@example.co"

    # 1) send-code: persists a register code with uid=None, type=email.
    resp = await auth_router.register_send_email_code(
        RegisterSendCodeRequest(email=email, captcha_id="x", captcha_code="y"),
        _Request(),
        db=test_db,
        _rl=None,
    )
    assert "已发送" in resp["message"]
    assert sent.get("email_code")
    code = await _latest_code(test_db, email, "register")
    assert code == sent["email_code"]

    # 2) register with the delivered code → TokenResponse, auto-login.
    token_resp = await auth_router.register_with_email(
        RegisterRequest(
            email=email, password="abc12345", code=code,
            captcha_id="x", captcha_code="y",
        ),
        _Request(),
        db=test_db,
        _rl=None,
    )
    assert token_resp.session_token
    assert token_resp.user_info.roles == ["free"]
    uid = token_resp.user_info.uid

    # User persisted with verified email + bcrypt password.
    from app.repository.user_repository import get_user_repository

    user = await get_user_repository().find_by_email(email, test_db)
    assert user is not None and user.uid == uid
    assert user.email_verified is True
    assert user.password_hash

    # 3) duplicate email → send-code returns 409.
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as excinfo:
        await auth_router.register_send_email_code(
            RegisterSendCodeRequest(email=email, captcha_id="x", captcha_code="y"),
            _Request(),
            db=test_db,
            _rl=None,
        )
    assert excinfo.value.status_code == 409

    # 4) re-register with the consumed code → 400.
    with pytest.raises(HTTPException) as excinfo:
        await auth_router.register_with_email(
            RegisterRequest(
                email=email, password="abc12345", code=code,
                captcha_id="x", captcha_code="y",
            ),
            _Request(),
            db=test_db,
            _rl=None,
        )
    assert excinfo.value.status_code == 400


@pytest.mark.asyncio
async def test_register_email_wrong_code_rejected(
    test_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi import HTTPException

    _patch_common(monkeypatch, test_db)
    await auth_router.register_send_email_code(
        RegisterSendCodeRequest(email="w@c.co", captcha_id="x", captcha_code="y"),
        _Request(),
        db=test_db,
        _rl=None,
    )
    with pytest.raises(HTTPException) as excinfo:
        await auth_router.register_with_email(
            RegisterRequest(
                email="w@c.co", password="abc12345", code="000000",
                captcha_id="x", captcha_code="y",
            ),
            _Request(),
            db=test_db,
            _rl=None,
        )
    assert excinfo.value.status_code == 400


# ── Phone SMS login / register flow ──────────────────────────────


@pytest.mark.asyncio
async def test_phone_login_registers_then_logs_in(
    test_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi import HTTPException

    phone = "13800138000"
    _patch_common(monkeypatch, test_db, sms=True)

    # 1) send-code (public login purpose): sms channel, uid=None.
    resp = await auth_router.send_phone_code(
        PhoneSendCodeRequest(phone=phone),
        _Request(),
        db=test_db,
        token_str=None,
        _rl=None,
    )
    assert "已发送" in resp["message"]
    code = await _latest_code(test_db, phone, "login")

    # 2) wrong code → 400.
    with pytest.raises(HTTPException) as excinfo:
        await auth_router.login_with_phone(
            PhoneLoginRequest(phone=phone, code="000000", captcha_id="x", captcha_code="y"),
            _Request(),
            db=test_db,
            _rl=None,
        )
    assert excinfo.value.status_code == 400

    # 3) correct code → auto-register + login.
    first = await auth_router.login_with_phone(
        PhoneLoginRequest(phone=phone, code=code, captcha_id="x", captcha_code="y"),
        _Request(),
        db=test_db,
        _rl=None,
    )
    assert first.session_token
    uid = first.user_info.uid

    from app.repository.user_repository import get_user_repository

    user = await get_user_repository().find_by_phone(phone, test_db)
    assert user is not None and user.phone_verified is True and not user.password_hash

    # 4) second login (fresh code) → same uid, fresh token. Clear the code
    # rows first to simulate the 60s per-target cooldown having elapsed.
    from sqlalchemy import delete

    from app.models import VerificationCode

    await test_db.execute(delete(VerificationCode).where(VerificationCode.target == phone))
    await test_db.commit()

    await auth_router.send_phone_code(
        PhoneSendCodeRequest(phone=phone), _Request(), db=test_db, token_str=None, _rl=None
    )
    code2 = await _latest_code(test_db, phone, "login")
    second = await auth_router.login_with_phone(
        PhoneLoginRequest(phone=phone, code=code2, captcha_id="x", captcha_code="y"),
        _Request(),
        db=test_db,
        _rl=None,
    )
    assert second.user_info.uid == uid
    assert second.session_token != first.session_token


@pytest.mark.asyncio
async def test_phone_send_code_bind_requires_auth(
    test_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi import HTTPException

    _patch_common(monkeypatch, test_db, sms=True)
    with pytest.raises(HTTPException) as excinfo:
        await auth_router.send_phone_code(
            PhoneSendCodeRequest(phone="13800138000", purpose="bind"),
            _Request(),
            db=test_db,
            token_str=None,
            _rl=None,
        )
    assert excinfo.value.status_code == 401


@pytest.mark.asyncio
async def test_phone_send_code_disabled_sms(
    test_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    if settings.sms_enabled:
        pytest.skip("SMS configured in this environment")
    from fastapi import HTTPException

    _patch_common(monkeypatch, test_db)  # no sms mock → real send_sms_code raises
    with pytest.raises(HTTPException) as excinfo:
        await auth_router.send_phone_code(
            PhoneSendCodeRequest(phone="13800138000"),
            _Request(),
            db=test_db,
            token_str=None,
            _rl=None,
        )
    assert excinfo.value.status_code == 400
    assert "短信服务未启用" in excinfo.value.detail


# ── Service level: password login by phone identifier ────────────


@pytest.mark.asyncio
async def test_login_with_password_accepts_phone_identifier(test_db) -> None:
    service = UserService(test_db, SnowflakeGenerator(worker_id=96))
    uid, _token, _created = await service.login_or_register_by_phone("13912345678")
    await service.set_password(uid, "passw0rd123")

    uid2, token2 = await service.login_with_password("13912345678", "passw0rd123")
    assert uid2 == uid
    assert token2.session_token

    with pytest.raises(ValueError):
        await service.login_with_password("13912345678", "wrongpass1")

    # Email lookup still works for email accounts.
    uid3, _ = await service.register_with_email("pw@user.co", "abc12345")
    uid4, _ = await service.login_with_password("pw@user.co", "abc12345")
    assert uid4 == uid3
