"""Local fixtures for security tests (rate limiting, login attempts)."""

import pytest
import pytest_asyncio
from unittest.mock import AsyncMock

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import Base


@pytest_asyncio.fixture(scope="function")
async def security_db():
    """Fresh in-memory SQLite DB for each test, with all tables created."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        echo=False,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False,
    )
    async with session_factory() as session:
        yield session
    await engine.dispose()


@pytest.fixture
def mock_redis_enabled(monkeypatch):
    """Make app.infra.redis.is_enabled() return True and rate_limit callable."""
    from app.infra import redis as redis_mod

    fake_client = AsyncMock()
    monkeypatch.setattr(redis_mod, "client", fake_client)
    monkeypatch.setattr(redis_mod, "is_enabled", lambda: True)
    return fake_client


@pytest.fixture
def mock_rate_limit_allow(monkeypatch):
    """Patch redis.rate_limit to always allow (return True)."""
    from app.infra import redis as redis_mod
    monkeypatch.setattr(redis_mod, "is_enabled", lambda: True)

    async def _allow(key, max_count, window_sec):
        return True

    monkeypatch.setattr(redis_mod, "rate_limit", _allow)


@pytest.fixture
def mock_rate_limit_block(monkeypatch):
    """Patch redis.rate_limit to always block (return False)."""
    from app.infra import redis as redis_mod
    monkeypatch.setattr(redis_mod, "is_enabled", lambda: True)

    async def _block(key, max_count, window_sec):
        return False

    monkeypatch.setattr(redis_mod, "rate_limit", _block)


@pytest.fixture
def mock_rate_limit_counting(monkeypatch):
    """Patch redis.rate_limit with a real counter for testing thresholds.

    Returns a dict tracking call counts per key so tests can simulate
    "Nth request gets blocked" behavior.
    """
    from app.infra import redis as redis_mod
    monkeypatch.setattr(redis_mod, "is_enabled", lambda: True)

    counts: dict[str, int] = {}

    async def _counting(key, max_count, window_sec):
        counts[key] = counts.get(key, 0) + 1
        return counts[key] <= max_count

    monkeypatch.setattr(redis_mod, "rate_limit", _counting)
    return counts


@pytest.fixture
def cooldown_settings(monkeypatch):
    """Replace `settings` in rate_limit_service with a mutable namespace.

    _Settings uses @property accessors, which can't be monkeypatched
    attribute-by-attribute. Swap the whole reference instead.
    """
    from types import SimpleNamespace
    from app.services.auth import rate_limit_service as mod

    fake = SimpleNamespace(
        rl_login_cooldown_threshold=5,
        rl_login_cooldown_seconds=900,
        rl_login_ip_max=10,
        rl_login_ip_window=60,
        rl_login_email_max=5,
        rl_login_email_window=300,
        rl_reset_request_ip_max=5,
        rl_reset_request_ip_window=3600,
        rl_reset_request_email_max=3,
        rl_reset_request_email_window=3600,
        rl_reset_ip_max=10,
        rl_reset_ip_window=3600,
        rl_send_code_ip_max=10,
        rl_send_code_ip_window=60,
        rl_send_code_uid_max=5,
        rl_send_code_uid_window=600,
        rl_change_password_uid_max=3,
        rl_change_password_uid_window=3600,
        rl_email_verify_ip_max=20,
        rl_email_verify_ip_window=60,
    )
    monkeypatch.setattr(mod, "settings", fake)
    return fake
