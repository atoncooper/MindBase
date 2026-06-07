"""
Async task lifecycle helpers — create, step, complete, fail.

Delegates persistence to AsyncTaskRepository.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from loguru import logger
from app.database import get_db_context
from app.repository.async_task_repository import (
    get_async_task_repository,
    AsyncTaskRepository,
)


class TaskTracker:
    """Create and update async_task rows for pipeline tracking."""

    def __init__(self, repo: AsyncTaskRepository | None = None):
        self._repo = repo or get_async_task_repository()

    @staticmethod
    def _new_id() -> str:
        return str(uuid.uuid4())

    async def create(
        self,
        uid: int,
        task_type: str,
        target: dict[str, Any],
    ) -> str:
        task_id = self._new_id()
        async with get_db_context() as db:
            await self._repo.create(task_id, task_type, target, uid=uid, db=db)
        logger.info(f"[TaskTracker] created task_id={task_id} type={task_type} uid={uid}")
        return task_id

    async def start(self, task_id: str) -> None:
        async with get_db_context() as db:
            await self._repo.update_fields(task_id, db, status="processing", progress=5)

    async def step(
        self, task_id: str, *, name: str, status: str,
        progress: int = 0, result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        async with get_db_context() as db:
            await self._repo.update_steps(
                task_id, db, name=name, status=status,
                progress=progress, result=result, error=error,
            )

    async def complete(
        self, task_id: str, result: dict[str, Any] | None = None,
    ) -> None:
        async with get_db_context() as db:
            await self._repo.update_fields(
                task_id, db, status="done", progress=100,
                result=result, completed_at=datetime.now(timezone.utc),
            )

    async def fail(self, task_id: str, error: str) -> None:
        async with get_db_context() as db:
            await self._repo.update_fields(
                task_id, db, status="failed", error=error,
                completed_at=datetime.now(timezone.utc),
            )

    async def set_progress(self, task_id: str, progress: int) -> None:
        async with get_db_context() as db:
            await self._repo.update_fields(task_id, db, progress=progress)

    async def update_fields(self, task_id: str, **kwargs) -> None:
        """Generic partial update for any async_task column."""
        async with get_db_context() as db:
            await self._repo.update_fields(task_id, db, **kwargs)

    async def list_pending(self, task_type: str) -> list[dict]:
        """List pending/processing tasks of the given type (for crash recovery)."""
        async with get_db_context() as db:
            rows = await self._repo.list_pending(task_type, db)
            return [
                {"task_id": t.task_id, "task_type": t.task_type,
                 "target": t.target, "status": t.status}
                for t in rows
            ]
