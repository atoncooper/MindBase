"""Async SQLAlchemy engine and session factory.

Reads core connection params (url, echo, pool_size, etc.) from the layered
config in app.infra.config. PG-specific tuning (application_name,
statement_timeout, ssl_mode) can still be overridden via env vars for quick
ops adjustments without touching YAML.

Driver:
    pip install asyncpg

Usage:
    from app.infra.rdbms import init_engine, get_db, close_engine

    # In FastAPI lifespan / startup:
    init_engine()

    # In FastAPI dependency:
    async def handler(db: Annotated[AsyncSession, Depends(get_db)]): ...

    # In background tasks / CLI / tests:
    async with get_db_context() as db:
        ...

    # In shutdown:
    await close_engine()

Business code in app/services/ depends on this module. The reverse is
forbidden — see CLAUDE.md §2.2 for the call-direction contract.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator

from loguru import logger
from sqlalchemy import text
from sqlalchemy.engine.url import URL, make_url
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


_TRUE_VALUES = {"1", "true", "yes", "on"}


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RdbmsConfig:
    url: str = "sqlite+aiosqlite:///./data/bilibili_rag.db"
    password_override: str | None = None  # Optional env override: RDBMS__PASSWORD
    echo: bool = False
    pool_size: int = 20
    max_overflow: int = 10
    pool_timeout: int = 30  # Seconds to wait for a free connection from the pool
    pool_recycle: int = 1800  # Max connection lifetime in seconds
    pool_pre_ping: bool = True  # SELECT 1 before checkout to drop stale conns
    application_name: str = "bilirag-api"  # Shows up in pg_stat_activity
    statement_timeout_ms: int = 60_000  # Per-statement timeout on the PG side
    connect_timeout: int = 10  # TCP connect timeout in seconds
    ssl_mode: str | None = None  # disable / prefer / require / verify-ca / verify-full


def _env_int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    return int(raw) if raw else default


def _env_bool(key: str, default: bool) -> bool:
    raw = os.environ.get(key)
    if raw is None:
        return default
    return raw.strip().lower() in _TRUE_VALUES


def _load_config() -> RdbmsConfig:
    """Load core params from the layered config; keep PG tuning in env fallback."""
    from app.infra.config import get_config

    rdbms = get_config().rdbms
    return RdbmsConfig(
        url=rdbms.url,
        password_override=os.environ.get("RDBMS__PASSWORD"),
        echo=rdbms.echo,
        pool_size=rdbms.pool_size,
        max_overflow=rdbms.max_overflow,
        pool_timeout=rdbms.pool_timeout,
        pool_recycle=rdbms.pool_recycle,
        pool_pre_ping=_env_bool("RDBMS__POOL_PRE_PING", True),
        application_name=os.environ.get("RDBMS__APPLICATION_NAME", "bilirag-api"),
        statement_timeout_ms=_env_int("RDBMS__STATEMENT_TIMEOUT_MS", 60_000),
        connect_timeout=_env_int("RDBMS__CONNECT_TIMEOUT", 10),
        ssl_mode=os.environ.get("RDBMS__SSL_MODE"),
    )


# ---------------------------------------------------------------------------
# Engine construction
# ---------------------------------------------------------------------------


def _resolve_url(cfg: RdbmsConfig) -> URL:
    url = make_url(cfg.url)
    if cfg.password_override:
        url = url.set(password=cfg.password_override)
    return url


def _build_connect_args(cfg: RdbmsConfig, dialect: str) -> dict[str, Any]:
    if not dialect.startswith("postgresql"):
        return {}
    server_settings: dict[str, str] = {
        "application_name": cfg.application_name,
        "statement_timeout": str(cfg.statement_timeout_ms),
    }
    args: dict[str, Any] = {
        "server_settings": server_settings,
        "timeout": cfg.connect_timeout,
    }
    if cfg.ssl_mode:
        args["ssl"] = cfg.ssl_mode
    return args


def _build_engine_kwargs(cfg: RdbmsConfig, dialect: str) -> dict[str, Any]:
    return {
        "echo": cfg.echo,
        "future": True,
        "pool_size": cfg.pool_size,
        "max_overflow": cfg.max_overflow,
        "pool_timeout": cfg.pool_timeout,
        "pool_recycle": cfg.pool_recycle,
        "pool_pre_ping": cfg.pool_pre_ping,
        "connect_args": _build_connect_args(cfg, dialect),
    }


# ---------------------------------------------------------------------------
# Module singleton & lifecycle
# ---------------------------------------------------------------------------

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def init_engine(cfg: RdbmsConfig | None = None) -> AsyncEngine:
    """Create the singleton AsyncEngine. Idempotent; call once at startup."""
    global _engine, _session_factory
    if _engine is not None:
        return _engine

    cfg = cfg or _load_config()
    url = _resolve_url(cfg)
    dialect = url.drivername

    if not dialect.startswith("postgresql"):
        logger.warning(
            "[RDBMS] non-postgres URL detected (driver={}); pool tuning params "
            "target asyncpg and may be ignored by other drivers",
            dialect,
        )

    logger.info(
        "[RDBMS] init engine driver={} host={} db={} pool={}+{} pre_ping={}",
        dialect,
        url.host,
        url.database,
        cfg.pool_size,
        cfg.max_overflow,
        cfg.pool_pre_ping,
    )

    _engine = create_async_engine(url, **_build_engine_kwargs(cfg, dialect))
    _session_factory = async_sessionmaker(
        _engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )

    from app.infra.config import config

    if config.slow_sql.enabled:
        from app.infra.slow_sql import install_hooks

        install_hooks(_engine)

    return _engine


def get_engine() -> AsyncEngine:
    if _engine is None:
        return init_engine()
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    if _session_factory is None:
        init_engine()
    assert _session_factory is not None
    return _session_factory


async def close_engine() -> None:
    """Dispose the engine pool. Call at shutdown."""
    global _engine, _session_factory
    if _engine is None:
        return
    logger.info("[RDBMS] disposing engine")
    await _engine.dispose()
    _engine = None
    _session_factory = None


# ---------------------------------------------------------------------------
# Session acquisition
# ---------------------------------------------------------------------------


async def get_db() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency injection entrypoint."""
    factory = get_session_factory()
    async with factory() as session:
        try:
            yield session
        finally:
            await session.close()


@asynccontextmanager
async def get_db_tx(
    *,
    readonly: bool = False,
) -> AsyncIterator[AsyncSession]:
    """FastAPI dependency with automatic commit / rollback via SQLAlchemy begin().

    Commits on success, rolls back on exception.  For read-only
    endpoints pass ``readonly=True``.

    Usage:
        async def handler(
            db: Annotated[AsyncSession, Depends(get_db_tx)]
        ): ...
    """
    factory = get_session_factory()
    async with factory.begin() as session:
        if readonly:
            await session.execute(text("SET TRANSACTION READ ONLY"))
        yield session


@asynccontextmanager
async def get_db_context() -> AsyncIterator[AsyncSession]:
    """Context manager for non-FastAPI code paths (tasks, CLI, tests)."""
    factory = get_session_factory()
    async with factory() as session:
        try:
            yield session
        finally:
            await session.close()


# ---------------------------------------------------------------------------
# Ops helpers
# ---------------------------------------------------------------------------


async def health_check() -> bool:
    """Return True if SELECT 1 succeeds. Logs warning on failure, never raises."""
    try:
        async with get_db_context() as db:
            await db.execute(text("SELECT 1"))
        return True
    except Exception as exc:
        logger.warning("[RDBMS] health check failed: {}", exc)
        return False


def is_postgres() -> bool:
    """Dialect helper — branch SQLite-vs-PG code (migrations, SQL dialects)."""
    if _engine is None:
        return False
    return _engine.dialect.name == "postgresql"
