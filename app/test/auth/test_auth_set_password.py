"""First-time password set (`POST /auth/password/set`) second-factor tests.

Covers verify_and_set_password orchestration: bare session is not enough —
email code (verified email), SMS code (verified phone only), or refusal
with neither verified contact (bind first). Runs against in-memory SQLite
with the verification service's transaction patched onto the test session.
"""

from __future__ import annotations

import secrets
from typing import Any

import pytest

from app.routers import auth as auth_router
from app.repository.user_repository import get_user_repository
from app.repository.verification_code_repository import (
    get_verification_code_repository,
)
from app.response import PasswordSetRequest
from app.services.auth import verification_service
from app.services.auth.user_service import UserService
from app.utils.snowflake import SnowflakeGenerator


class _FakeTxScope:
    def __init__(self, db: Any) -> None:
        self._db = db

    async def __aenter__(self) -> Any:
        return self._db

    async def __aexit__(self, *_a: Any) -> bool:
        return False


@pytest.fixture(autouse=True)
def _patch_tx(monkeypatch: pytest.MonkeyPatch, test_db: Any) -> None:
    monkeypatch.setattr(
        verification_service, "transactional_scope", lambda: _FakeTxScope(test_db)
    )


async def _make_user(
    test_db: Any,
    *,
    email: str | None = None,
    email_verified: bool = False,
    phone: str | None = None,
    phone_verified: bool = False,
) -> int:
    """OAuth-style user (no password) with configurable contact state."""
    service = UserService(test_db, SnowflakeGenerator(worker_id=95))
    uid, _token = await service.ensure_user_from_oauth(
        provider="bilibili", provider_uid=f"b-{secrets.token_hex(4)}"
    )
    await get_user_repository().update(
        uid,
        test_db,
        email=email,
        email_verified=email_verified,
        phone=phone,
        phone_verified=phone_verified,
    )
    return uid


async def _issue_code(
    test_db: Any, *, uid: int, target: str, purpose: str, code: str = "654321"
) -> str:
    await get_verification_code_repository().create(
        test_db, uid=uid, target=target, purpose=purpose, code=code, ttl_seconds=300
    )
    return code


# ── Refusals ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_set_password_refused_without_verified_contact(test_db) -> None:
    uid = await _make_user(test_db)  # pure OAuth account
    vs = verification_service.VerificationService()
    with pytest.raises(ValueError, match="请先绑定并验证邮箱或手机号"):
        await vs.verify_and_set_password(
            test_db, uid=uid, new_password="abc12345",
            email_code=None, sms_code=None, sf=SnowflakeGenerator(worker_id=1),
        )
    user = await get_user_repository().get_by_uid(uid, test_db)
    assert user.password_hash is None


@pytest.mark.asyncio
async def test_set_password_requires_email_code_when_verified_email(
    test_db,
) -> None:
    uid = await _make_user(test_db, email="u@x.co", email_verified=True)
    vs = verification_service.VerificationService()
    with pytest.raises(ValueError, match="设置密码需要邮箱验证码"):
        await vs.verify_and_set_password(
            test_db, uid=uid, new_password="abc12345",
            email_code=None, sms_code=None, sf=SnowflakeGenerator(worker_id=1),
        )


@pytest.mark.asyncio
async def test_set_password_requires_sms_code_when_only_phone(
    test_db,
) -> None:
    uid = await _make_user(test_db, phone="13800138000", phone_verified=True)
    vs = verification_service.VerificationService()
    with pytest.raises(ValueError, match="设置密码需要短信验证码"):
        await vs.verify_and_set_password(
            test_db, uid=uid, new_password="abc12345",
            email_code=None, sms_code=None, sf=SnowflakeGenerator(worker_id=1),
        )


@pytest.mark.asyncio
async def test_set_password_wrong_code_rejected(test_db) -> None:
    uid = await _make_user(test_db, email="u@x.co", email_verified=True)
    code = await _issue_code(test_db, uid=uid, target="u@x.co", purpose="twofa")
    assert code == "654321"
    vs = verification_service.VerificationService()
    with pytest.raises(ValueError, match="验证码不正确"):
        await vs.verify_and_set_password(
            test_db, uid=uid, new_password="abc12345",
            email_code="000000", sms_code=None, sf=SnowflakeGenerator(worker_id=1),
        )
    user = await get_user_repository().get_by_uid(uid, test_db)
    assert user.password_hash is None


# ── Happy paths ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_set_password_with_email_code_via_router(test_db) -> None:
    uid = await _make_user(test_db, email="u@x.co", email_verified=True)
    code = await _issue_code(test_db, uid=uid, target="u@x.co", purpose="twofa")

    resp = await auth_router.set_password(
        PasswordSetRequest(password="abc12345", email_code=code),
        uid=uid,
        db=test_db,
    )
    assert resp["message"] == "密码设置成功"

    # Password actually works for login.
    service = UserService(test_db, SnowflakeGenerator(worker_id=94))
    uid2, _ = await service.login_with_password("u@x.co", "abc12345")
    assert uid2 == uid

    # The code was consumed — replaying it cannot set another password.
    user = await get_user_repository().get_by_uid(uid, test_db)
    assert user.password_hash
    with pytest.raises(Exception):
        await auth_router.set_password(
            PasswordSetRequest(password="zzz99988", email_code=code),
            uid=uid,
            db=test_db,
        )


@pytest.mark.asyncio
async def test_set_password_with_sms_code_when_only_phone(test_db) -> None:
    uid = await _make_user(test_db, phone="13800138000", phone_verified=True)
    code = await _issue_code(
        test_db, uid=uid, target="13800138000", purpose="twofa_sms"
    )

    resp = await auth_router.set_password(
        PasswordSetRequest(password="abc12345", sms_code=code),
        uid=uid,
        db=test_db,
    )
    assert resp["message"] == "密码设置成功"

    service = UserService(test_db, SnowflakeGenerator(worker_id=94))
    uid2, _ = await service.login_with_password("13800138000", "abc12345")
    assert uid2 == uid


@pytest.mark.asyncio
async def test_set_password_refuses_when_password_already_set(test_db) -> None:
    uid = await _make_user(test_db, email="u@x.co", email_verified=True)
    code = await _issue_code(test_db, uid=uid, target="u@x.co", purpose="twofa")

    await auth_router.set_password(
        PasswordSetRequest(password="abc12345", email_code=code),
        uid=uid,
        db=test_db,
    )
    # Second set attempt with a fresh code → refused by set_password itself.
    code2 = await _issue_code(test_db, uid=uid, target="u@x.co", purpose="twofa")
    with pytest.raises(Exception):
        await auth_router.set_password(
            PasswordSetRequest(password="newpass99", email_code=code2),
            uid=uid,
            db=test_db,
        )
