"""
Shared-memory cache for async tasks, refreshed by a subprocess every 30 seconds.

Design:
  - multiprocessing.Manager().dict() for cross-process shared state
  - Subprocess: SELECT * FROM async_tasks → write to shared dict → sleep 30s
  - Main process: WebSocket reads shared dict directly (no DB query)

Cache structure:
  {
      "tasks":       list[dict],    # all task records
      "updated_at":  float,         # last refresh timestamp
      "count":       int,           # total task count
  }
"""

from __future__ import annotations

import multiprocessing
import time
from datetime import datetime, timedelta, timezone
from multiprocessing.managers import SyncManager
from typing import Any

from loguru import logger

# Shared state — populated by subprocess, read by main process
_manager: SyncManager | None = None
_shared_cache: Any = None  # multiprocessing.Manager().dict()
_refresher_process: multiprocessing.Process | None = None

CACHE_KEY = "async_tasks_cache"
REFRESH_INTERVAL = 30  # 30 seconds

# Cache visibility window for finished tasks. Older done/failed rows stay
# in MySQL (audit trail) but are not pushed to WebSocket clients.
RECENT_DONE_WINDOW = timedelta(hours=1)

# Daily prune of fully-resolved rows so async_tasks doesn't grow forever.
PRUNE_INTERVAL_SEC = 24 * 3600
PRUNE_RETENTION = timedelta(days=7)


def _refresher_worker(
    shared_dict: Any,
    database_url: str,
    interval: int = REFRESH_INTERVAL,
) -> None:
    """Subprocess entry point: query DB periodically and write cache.

    Runs a single event loop with a single engine for the lifetime of the
    subprocess — recreating either on every tick would churn the
    connection pool unnecessarily.
    """
    import asyncio

    logger.info("[TaskCache] refresher subprocess started")

    async def _loop() -> None:
        from sqlalchemy.ext.asyncio import (
            create_async_engine,
            AsyncSession,
            async_sessionmaker,
        )

        engine = create_async_engine(database_url, echo=False)
        factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        last_prune_at = 0.0
        try:
            while True:
                try:
                    await _refresh_from_db(factory, shared_dict)
                except Exception as e:
                    logger.error(f"[TaskCache] refresh failed: {e}")

                now = time.time()
                if now - last_prune_at >= PRUNE_INTERVAL_SEC:
                    last_prune_at = now
                    try:
                        await _prune(factory)
                    except Exception as e:
                        logger.error(f"[TaskCache] prune failed: {e}")

                await asyncio.sleep(interval)
        finally:
            await engine.dispose()

    asyncio.run(_loop())


async def _refresh_from_db(factory, shared_dict: Any) -> None:
    """Query MySQL and update the shared dict (read-only)."""
    from sqlalchemy import select, or_
    from app.models import AsyncTask

    # Only push tasks the UI actually cares about: anything still in
    # flight, plus anything that finished within the visibility window.
    # Older finished rows stay in MySQL as audit trail and are pruned
    # separately.
    recent_cutoff = datetime.now(timezone.utc) - RECENT_DONE_WINDOW
    stmt = (
        select(AsyncTask)
        .where(
            or_(
                AsyncTask.status.in_(["pending", "processing"]),
                AsyncTask.completed_at >= recent_cutoff,
            )
        )
        .order_by(AsyncTask.updated_at.desc())
        .limit(200)
    )

    async with factory() as db:
        result = await db.execute(stmt)
        tasks = result.scalars().all()

        data = [
            {
                "task_id": t.task_id,
                "uid": t.uid,
                "task_type": t.task_type,
                "target": t.target,
                "status": t.status,
                "progress": t.progress,
                "steps": t.steps,
                "result": t.result,
                "error": t.error,
                "created_at": t.created_at.isoformat() if t.created_at else None,
                "updated_at": t.updated_at.isoformat() if t.updated_at else None,
                "completed_at": (
                    t.completed_at.isoformat() if t.completed_at else None
                ),
            }
            for t in tasks
        ]

    shared_dict[CACHE_KEY] = {
        "tasks": data,
        "updated_at": time.time(),
        "count": len(data),
    }
    if data:
        logger.info("[TaskCache] refreshed {} tasks", len(data))
    else:
        logger.debug("[TaskCache] refreshed 0 tasks")


async def _prune(factory) -> None:
    """Delete fully-resolved tasks older than PRUNE_RETENTION."""
    from app.repository.async_task_repository import AsyncTaskRepository

    cutoff = datetime.now(timezone.utc) - PRUNE_RETENTION
    # Subprocess owns its own engine, so app.infra.transaction (which
    # binds to the main-process factory) cannot be reused. session.begin()
    # gives the same commit-on-success / rollback-on-error semantics with
    # the subprocess engine.
    async with factory() as db:
        async with db.begin():
            purged = await AsyncTaskRepository().delete_completed_before(cutoff, db)
    if purged:
        logger.info(
            "[TaskCache] pruned {} finished tasks older than {}",
            purged,
            cutoff.isoformat(),
        )


# ── Public API (called from main process) ──────────────────────────


def start_cache_refresher(database_url: str) -> None:
    """Start the subprocess that refreshes the cache every 5 minutes."""
    global _manager, _shared_cache, _refresher_process

    if _refresher_process is not None:
        logger.warning("[TaskCache] refresher already running")
        return

    _manager = multiprocessing.Manager()
    _shared_cache = _manager.dict()
    _shared_cache[CACHE_KEY] = {"tasks": [], "updated_at": 0, "count": 0}

    _refresher_process = multiprocessing.Process(
        target=_refresher_worker,
        args=(_shared_cache, database_url, REFRESH_INTERVAL),
        name="task-cache-refresher",
        daemon=True,
    )
    _refresher_process.start()
    logger.info(
        "[TaskCache] refresher subprocess started (interval={}s)", REFRESH_INTERVAL
    )


def stop_cache_refresher() -> None:
    """Stop the subprocess and clean up shared memory."""
    global _manager, _shared_cache, _refresher_process

    if _refresher_process is not None:
        _refresher_process.terminate()
        _refresher_process.join(timeout=5)
        _refresher_process = None
        logger.info("[TaskCache] refresher subprocess stopped")

    if _manager is not None:
        _manager.shutdown()
        _manager = None
    _shared_cache = None


def get_cached_tasks(
    uid: int | None = None,
    task_type: str | None = None,
    status: str | None = None,
) -> list[dict]:
    """Read task list from shared cache (no DB query)."""
    if _shared_cache is None:
        return []

    cache = _shared_cache.get(CACHE_KEY, {})
    tasks: list[dict] = cache.get("tasks", [])

    if uid is not None:
        tasks = [t for t in tasks if t.get("uid") == uid]
    if task_type:
        tasks = [t for t in tasks if t.get("task_type") == task_type]
    if status:
        tasks = [t for t in tasks if t.get("status") == status]

    return tasks


def get_cached_task(task_id: str) -> dict | None:
    """Get a single task from cache."""
    tasks = get_cached_tasks()
    for t in tasks:
        if t["task_id"] == task_id:
            return t
    return None
