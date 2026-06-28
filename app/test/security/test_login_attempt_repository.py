"""Tests for LoginAttemptRepository — DB-backed failure counting + cooldown queries.

Uses an in-memory SQLite DB (security_db fixture) for real SQL verification.
No mocking — we want to verify the actual SQL queries return correct counts.
"""

import pytest
from datetime import datetime, timedelta, timezone

from app.repository.login_attempt_repository import (
    LoginAttemptRepository,
    get_login_attempt_repository,
)


@pytest.mark.asyncio
async def test_create_persists_row(security_db):
    """A created attempt should be queryable by its attributes."""
    repo = LoginAttemptRepository()
    await repo.create(
        security_db,
        uid=100,
        email="alice@example.com",
        ip="1.2.3.4",
        device_id="dev-abc",
        success=False,
        failure_reason="invalid_credentials",
    )

    failures = await repo.count_recent_failures_by_email(
        security_db,
        email="alice@example.com",
        since=datetime.now(timezone.utc) - timedelta(minutes=5),
    )
    assert failures == 1


@pytest.mark.asyncio
async def test_count_recent_failures_by_ip_includes_only_failures(security_db):
    """Successful logins from the same IP must not inflate failure count."""
    repo = LoginAttemptRepository()
    now = datetime.now(timezone.utc)
    since = now - timedelta(minutes=5)

    # 2 failures + 1 success from same IP
    await repo.create(security_db, uid=None, email="a@x.com", ip="1.2.3.4",
                     device_id="d", success=False, failure_reason="x")
    await repo.create(security_db, uid=None, email="b@x.com", ip="1.2.3.4",
                     device_id="d", success=False, failure_reason="x")
    await repo.create(security_db, uid=1, email="c@x.com", ip="1.2.3.4",
                     device_id="d", success=True)

    count = await repo.count_recent_failures_by_ip(security_db, ip="1.2.3.4", since=since)
    assert count == 2


@pytest.mark.asyncio
async def test_count_recent_failures_by_email_excludes_old_records(security_db):
    """Attempts older than `since` should be excluded from the count."""
    repo = LoginAttemptRepository()
    now = datetime.now(timezone.utc)

    # Old failure (10 minutes ago)
    old = await repo.create(
        security_db, uid=None, email="a@x.com", ip="1.1.1.1",
        device_id="d", success=False, failure_reason="x",
    )
    # Manually backdate the created_at
    from app.models import LoginAttempt
    from sqlalchemy import update
    await security_db.execute(
        update(LoginAttempt)
        .where(LoginAttempt.id == old.id)
        .values(created_at=now - timedelta(minutes=10))
    )
    await security_db.commit()

    # Recent failure (just now)
    await repo.create(security_db, uid=None, email="a@x.com", ip="1.1.1.1",
                     device_id="d", success=False, failure_reason="x")

    count = await repo.count_recent_failures_by_email(
        security_db, email="a@x.com",
        since=now - timedelta(minutes=5),
    )
    assert count == 1


@pytest.mark.asyncio
async def test_count_recent_failures_by_uid(security_db):
    """Per-uid failure aggregation."""
    repo = LoginAttemptRepository()
    now = datetime.now(timezone.utc)
    since = now - timedelta(minutes=5)

    await repo.create(security_db, uid=42, email="a@x.com", ip="1.1.1.1",
                     device_id="d", success=False)
    await repo.create(security_db, uid=42, email="a@x.com", ip="2.2.2.2",
                     device_id="d", success=False)
    await repo.create(security_db, uid=42, email="a@x.com", ip="3.3.3.3",
                     device_id="d", success=True)
    await repo.create(security_db, uid=99, email="b@x.com", ip="4.4.4.4",
                     device_id="d", success=False)

    count = await repo.count_recent_failures_by_uid(security_db, uid=42, since=since)
    assert count == 2  # 2 failures for uid=42, success excluded


@pytest.mark.asyncio
async def test_has_recent_success_by_email(security_db):
    """Cooldown can be skipped for accounts that recently logged in successfully."""
    repo = LoginAttemptRepository()
    now = datetime.now(timezone.utc)
    since = now - timedelta(minutes=30)

    # No success yet
    await repo.create(security_db, uid=1, email="a@x.com", ip="1.1.1.1",
                     device_id="d", success=False)
    assert await repo.has_recent_success_by_email(
        security_db, email="a@x.com", since=since,
    ) is False

    # Add a success
    await repo.create(security_db, uid=1, email="a@x.com", ip="1.1.1.1",
                     device_id="d", success=True)
    assert await repo.has_recent_success_by_email(
        security_db, email="a@x.com", since=since,
    ) is True


@pytest.mark.asyncio
async def test_singleton_get_repository_returns_same_instance():
    """get_login_attempt_repository() must return the same instance each call."""
    a = get_login_attempt_repository()
    b = get_login_attempt_repository()
    assert a is b


@pytest.mark.asyncio
async def test_count_returns_zero_for_empty_table(security_db):
    """No attempts → zero failures (not None, not error)."""
    repo = LoginAttemptRepository()
    since = datetime.now(timezone.utc) - timedelta(minutes=5)

    assert await repo.count_recent_failures_by_ip(security_db, ip="9.9.9.9", since=since) == 0
    assert await repo.count_recent_failures_by_email(security_db, email="nobody@x.com", since=since) == 0
    assert await repo.count_recent_failures_by_uid(security_db, uid=999, since=since) == 0
