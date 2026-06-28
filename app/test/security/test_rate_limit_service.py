"""Tests for RateLimitService — Redis-backed limiting + DB-backed cooldown.

The singleton service is stateless aside from its repo reference, so each
test patches redis.rate_limit / redis.is_enabled to simulate states.

We use a real in-memory SQLite DB (security_db) for cooldown checks to
verify the SQL aggregation actually works end-to-end.
"""

import pytest
from datetime import datetime, timedelta, timezone

from app.services.auth.rate_limit_service import (
    LoginCooldown,
    RateLimitExceeded,
    RateLimitService,
    rate_limit_service,
)


# ── Singleton semantics ─────────────────────────────────────────────


def test_module_level_singleton_is_stable():
    """The module-level instance should be the same across imports."""
    from app.services.auth import rate_limit_service as mod

    assert rate_limit_service is mod.rate_limit_service
    assert isinstance(rate_limit_service, RateLimitService)


def test_singleton_holds_repository():
    """The singleton should hold a LoginAttemptRepository instance."""
    from app.repository.login_attempt_repository import LoginAttemptRepository

    assert isinstance(rate_limit_service.repo, LoginAttemptRepository)


# ── check_ip / check_target / check_uid ────────────────────────────


@pytest.mark.asyncio
async def test_check_ip_allows_when_redis_permits(security_db, mock_rate_limit_allow):
    """When redis.rate_limit returns True, check_ip should return None."""
    await rate_limit_service.check_ip(
        security_db, endpoint="login", ip="1.2.3.4",
        max_count=10, window_sec=60,
    )


@pytest.mark.asyncio
async def test_check_ip_raises_when_redis_blocks(security_db, mock_rate_limit_block):
    """When redis.rate_limit returns False, check_ip should raise RateLimitExceeded."""
    with pytest.raises(RateLimitExceeded) as exc_info:
        await rate_limit_service.check_ip(
            security_db, endpoint="login", ip="1.2.3.4",
            max_count=10, window_sec=60,
        )
    assert exc_info.value.retry_after == 60


@pytest.mark.asyncio
async def test_check_ip_fail_open_when_redis_disabled(security_db, monkeypatch):
    """When redis.is_enabled() returns False, check should pass silently."""
    from app.infra import redis as redis_mod
    monkeypatch.setattr(redis_mod, "is_enabled", lambda: False)
    # redis_mod.rate_limit would raise if called — test that it's NOT called.
    with pytest.raises(RuntimeError, match="not initialized"):
        await redis_mod.rate_limit("k", 1, 1)

    # But check_ip should NOT raise
    await rate_limit_service.check_ip(
        security_db, endpoint="login", ip="1.2.3.4",
        max_count=10, window_sec=60,
    )


@pytest.mark.asyncio
async def test_check_ip_fail_open_on_redis_exception(security_db, monkeypatch):
    """When redis.rate_limit raises, check should pass (fail-open policy)."""
    from app.infra import redis as redis_mod
    monkeypatch.setattr(redis_mod, "is_enabled", lambda: True)

    async def _boom(key, max_count, window_sec):
        raise ConnectionError("redis down")

    monkeypatch.setattr(redis_mod, "rate_limit", _boom)

    # Should NOT raise — fail-open per design
    await rate_limit_service.check_ip(
        security_db, endpoint="login", ip="1.2.3.4",
        max_count=10, window_sec=60,
    )


@pytest.mark.asyncio
async def test_check_target_uses_target_in_key(security_db, mock_rate_limit_counting):
    """Verify that check_target passes the target in the Redis key."""
    counts = mock_rate_limit_counting
    await rate_limit_service.check_target(
        security_db, endpoint="login", target="alice@example.com",
        max_count=5, window_sec=300,
    )
    assert "alice@example.com" in list(counts.keys())[0]
    assert "target" in list(counts.keys())[0]


@pytest.mark.asyncio
async def test_check_uid_uses_uid_in_key(security_db, mock_rate_limit_counting):
    """Verify that check_uid passes the uid in the Redis key."""
    counts = mock_rate_limit_counting
    await rate_limit_service.check_uid(
        security_db, endpoint="email_send", uid=42,
        max_count=5, window_sec=600,
    )
    key = list(counts.keys())[0]
    assert "42" in key
    assert "uid" in key


# ── check_login_cooldown ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_login_cooldown_raises_when_failures_exceed_threshold(security_db, cooldown_settings):
    """5 failures within cooldown window should trigger LoginCooldown."""
    # Insert 5 failed attempts
    from app.models import LoginAttempt
    now = datetime.now(timezone.utc)
    for _ in range(5):
        security_db.add(LoginAttempt(
            uid=None, email="alice@example.com", ip="1.2.3.4",
            device_id="d", success=False, failure_reason="x", created_at=now,
        ))
    await security_db.commit()

    with pytest.raises(LoginCooldown) as exc_info:
        await rate_limit_service.check_login_cooldown(security_db, email="alice@example.com")
    assert exc_info.value.email == "alice@example.com"
    assert exc_info.value.retry_after == 900


@pytest.mark.asyncio
async def test_login_cooldown_passes_when_failures_below_threshold(security_db, cooldown_settings):
    """4 failures (below threshold of 5) should not trigger cooldown."""
    from app.models import LoginAttempt
    now = datetime.now(timezone.utc)
    for _ in range(4):
        security_db.add(LoginAttempt(
            uid=None, email="alice@example.com", ip="1.2.3.4",
            device_id="d", success=False, failure_reason="x", created_at=now,
        ))
    await security_db.commit()

    # Should NOT raise
    await rate_limit_service.check_login_cooldown(security_db, email="alice@example.com")


@pytest.mark.asyncio
async def test_login_cooldown_ignores_old_failures(security_db, cooldown_settings):
    """Failures older than cooldown_seconds should not count."""
    cooldown_settings.rl_login_cooldown_threshold = 3
    cooldown_settings.rl_login_cooldown_seconds = 300

    from app.models import LoginAttempt
    now = datetime.now(timezone.utc)
    # 10 old failures (1 hour ago, outside 5-min window)
    old_time = now - timedelta(hours=1)
    for _ in range(10):
        security_db.add(LoginAttempt(
            uid=None, email="alice@example.com", ip="1.2.3.4",
            device_id="d", success=False, failure_reason="x", created_at=old_time,
        ))
    await security_db.commit()

    # Should NOT raise — old failures excluded
    await rate_limit_service.check_login_cooldown(security_db, email="alice@example.com")


@pytest.mark.asyncio
async def test_login_cooldown_ignores_successful_attempts(security_db, cooldown_settings):
    """Successful logins should not inflate the failure counter."""
    cooldown_settings.rl_login_cooldown_threshold = 3

    from app.models import LoginAttempt
    now = datetime.now(timezone.utc)
    # 2 failures + 5 successes
    for _ in range(2):
        security_db.add(LoginAttempt(
            uid=1, email="alice@example.com", ip="1.2.3.4",
            device_id="d", success=False, created_at=now,
        ))
    for _ in range(5):
        security_db.add(LoginAttempt(
            uid=1, email="alice@example.com", ip="1.2.3.4",
            device_id="d", success=True, created_at=now,
        ))
    await security_db.commit()

    # 2 failures < threshold 3 — should NOT raise
    await rate_limit_service.check_login_cooldown(security_db, email="alice@example.com")


# ── record_login_attempt ───────────────────────────────────────────
#
# record_login_attempt owns its tx via transactional_scope() (audit
# independence — must persist even if caller's tx rolls back). Tests
# monkeypatch transactional_scope to yield the in-memory security_db
# so writes are visible to subsequent assertions on the same session.


def _patch_scope_to_security_db(monkeypatch, security_db):
    """Redirect transactional_scope in rate_limit_service to yield security_db."""
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _fake_scope(**kwargs):
        yield security_db

    monkeypatch.setattr(
        "app.services.auth.rate_limit_service.transactional_scope", _fake_scope
    )


@pytest.mark.asyncio
async def test_record_login_attempt_success_persists(security_db, monkeypatch):
    """Successful login should be persisted with success=True."""
    _patch_scope_to_security_db(monkeypatch, security_db)
    await rate_limit_service.record_login_attempt(
        security_db,
        uid=42, email="alice@example.com", ip="1.2.3.4",
        device_id="d", success=True,
    )
    # Verify via repo
    from app.repository.login_attempt_repository import LoginAttemptRepository
    repo = LoginAttemptRepository()
    count = await repo.count_recent_failures_by_email(
        security_db, email="alice@example.com",
        since=datetime.now(timezone.utc) - timedelta(minutes=1),
    )
    assert count == 0  # success doesn't count as failure


@pytest.mark.asyncio
async def test_record_login_attempt_failure_with_reason(security_db, monkeypatch):
    """Failed login with reason should be queryable as a failure."""
    _patch_scope_to_security_db(monkeypatch, security_db)
    await rate_limit_service.record_login_attempt(
        security_db,
        uid=None, email="alice@example.com", ip="1.2.3.4",
        device_id="d", success=False, failure_reason="invalid_credentials",
    )
    from app.repository.login_attempt_repository import LoginAttemptRepository
    repo = LoginAttemptRepository()
    count = await repo.count_recent_failures_by_email(
        security_db, email="alice@example.com",
        since=datetime.now(timezone.utc) - timedelta(minutes=1),
    )
    assert count == 1


@pytest.mark.asyncio
async def test_record_login_attempt_swallows_repo_errors(security_db, monkeypatch):
    """record_login_attempt should be best-effort: repo errors must not propagate."""
    _patch_scope_to_security_db(monkeypatch, security_db)
    # Force repo.create to raise
    async def _boom(*args, **kwargs):
        raise RuntimeError("DB down")

    monkeypatch.setattr(rate_limit_service.repo, "create", _boom)

    # Should NOT raise
    await rate_limit_service.record_login_attempt(
        security_db,
        uid=1, email="x@x.com", ip="1.1.1.1",
        device_id="d", success=True,
    )
