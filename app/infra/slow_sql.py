"""Slow SQL capture via SQLAlchemy event hooks.

Zero-intrusion: no business code changes required.
Hooks are installed once during engine initialisation.

Usage:
    from app.infra.rdbms import init_engine
    from app.infra.slow_sql import install_hooks

    engine = init_engine()
    install_hooks(engine)

Queries slower than ``slow_sql.threshold_ms`` are fingerprinted,
sampled (max 3 per fingerprint per minute), and optionally persisted.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import time
from collections import defaultdict
from contextvars import ContextVar
from typing import Any

from loguru import logger
from sqlalchemy import event, text

from app.infra.config import config

# ---------------------------------------------------------------------------
# SQL fingerprinting — strip literals to allow aggregation
# ---------------------------------------------------------------------------

_FINGERPRINT_RE = re.compile(r"'[^']*'|\$\d+|\?|\b\d+\b")


def _fingerprint(sql: str) -> str:
    """Return a normalised SQL fingerprint (first 16 hex chars of SHA-256)."""
    normalised = _FINGERPRINT_RE.sub("?", sql.strip().lower())
    normalised = re.sub(r"\s+", " ", normalised)
    return hashlib.sha256(normalised.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Rate-limit bucket: fingerprint -> list of timestamps
# ---------------------------------------------------------------------------

_fingerprint_bucket: defaultdict[str, list[float]] = defaultdict(list)

# Per-context execution start times (keyed by context id)
_state: ContextVar[dict[int, float]] = ContextVar("slow_sql_state", default={})


# ---------------------------------------------------------------------------
# Event handlers (sync — called on engine.sync_engine)
# ---------------------------------------------------------------------------

def _before_cursor_execute(
    conn, cursor, statement: str, parameters, context, executemany
) -> None:
    if not config.slow_sql.enabled:
        return
    _state.get()[id(context)] = time.perf_counter_ns()


def _after_cursor_execute(
    conn, cursor, statement: str, parameters, context, executemany
) -> None:
    if not config.slow_sql.enabled:
        return
    start_ns = _state.get().pop(id(context), None)
    if start_ns is None:
        return

    elapsed_ms = (time.perf_counter_ns() - start_ns) / 1_000_000
    if elapsed_ms < config.slow_sql.threshold_ms:
        return

    fingerprint = _fingerprint(statement)
    bucket = _fingerprint_bucket[fingerprint]
    now = time.time()

    # Evict entries older than 60 s
    bucket[:] = [t for t in bucket if now - t < 60]
    if len(bucket) >= config.slow_sql.max_samples_per_fingerprint:
        return
    bucket.append(now)

    record = {
        "fingerprint": fingerprint,
        "sql": statement[:2000],
        "elapsed_ms": round(elapsed_ms, 3),
        "params_count": len(parameters) if isinstance(parameters, (list, tuple, dict)) else 0,
        "dialect": getattr(conn.dialect, "name", "unknown"),
        "created_at": now,
    }

    if config.slow_sql.log_to_console:
        logger.warning(
            "[SLOW_SQL] {elapsed_ms:.1f}ms | {dialect} | {fingerprint} | {sql_snippet}",
            elapsed_ms=elapsed_ms,
            dialect=record["dialect"],
            fingerprint=fingerprint,
            sql_snippet=statement[:120].replace("\n", " "),
        )

    if config.slow_sql.log_to_storage:
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(_persist(record))
        except RuntimeError:
            pass


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

async def _persist(record: dict[str, Any]) -> None:
    """Write a slow-query record to Mongo (if enabled) or SQLite fallback."""
    if config.mongo.enabled:
        try:
            from app.infra.mongo import get_mongo
            await get_mongo().slow_queries.insert_one(record)
            return
        except Exception:
            logger.exception("[SLOW_SQL] mongo persist failed, falling back to sqlite")

    from app.infra.rdbms import get_engine
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS slow_queries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    fingerprint VARCHAR(16) NOT NULL,
                    sql TEXT NOT NULL,
                    elapsed_ms REAL NOT NULL,
                    params_count INTEGER NOT NULL DEFAULT 0,
                    dialect VARCHAR(20) NOT NULL,
                    created_at REAL NOT NULL
                )
                """
            )
        )
        await conn.execute(
            text(
                """
                INSERT INTO slow_queries
                    (fingerprint, sql, elapsed_ms, params_count, dialect, created_at)
                VALUES
                    (:fingerprint, :sql, :elapsed_ms, :params_count, :dialect, :created_at)
                """
            ),
            record,
        )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def install_hooks(engine) -> None:
    """Attach before/after cursor listeners to *engine*.

    *engine* may be an async engine; hooks are attached to the
    underlying sync bridge via ``engine.sync_engine``.
    """
    event.listen(engine.sync_engine, "before_cursor_execute", _before_cursor_execute)
    event.listen(engine.sync_engine, "after_cursor_execute", _after_cursor_execute)
    logger.info(
        "[SLOW_SQL] hooks installed, threshold=%dms",
        config.slow_sql.threshold_ms,
    )


async def cleanup_old_records() -> None:
    """Delete slow-query records older than ``slow_sql.retention_days``."""
    cutoff = time.time() - config.slow_sql.retention_days * 86400

    if config.mongo.enabled:
        try:
            from app.infra.mongo import get_mongo
            await get_mongo().slow_queries.delete_many({"created_at": {"$lt": cutoff}})
            return
        except Exception:
            logger.exception("[SLOW_SQL] mongo cleanup failed")

    from app.infra.rdbms import get_engine
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.execute(
            text("DELETE FROM slow_queries WHERE created_at < :cutoff"),
            {"cutoff": cutoff},
        )
