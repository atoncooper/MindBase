"""
Task persistence — abstract interface + SQL implementation.

Delegates CRUD to AsyncTaskRepository.
"""

from abc import ABC, abstractmethod
from typing import Optional

from loguru import logger

from app.database import get_db_context
from app.repository.async_task_repository import (
    get_async_task_repository, AsyncTaskRepository,
)


class TaskPersistence(ABC):
    """Abstract task storage — swappable for Redis in the future."""

    @abstractmethod
    async def create(self, task_id: str, task_type: str, target: dict, uid: int | None = None) -> None: ...

    @abstractmethod
    async def update(self, task_id: str, **kwargs) -> None: ...

    @abstractmethod
    async def get(self, task_id: str) -> Optional[dict]: ...

    @abstractmethod
    async def list_pending(self, task_type: str) -> list[dict]: ...


class SQLiteTaskPersistence(TaskPersistence):
    """SQL implementation — delegates to AsyncTaskRepository."""

    def __init__(self, repo: AsyncTaskRepository | None = None):
        self._repo = repo or get_async_task_repository()

    async def create(self, task_id: str, task_type: str, target: dict, uid: int | None = None) -> None:
        async with get_db_context() as db:
            await self._repo.create(task_id, task_type, target, uid=uid, db=db)
            logger.debug(f"[TaskStore] created task_id={task_id}, type={task_type}, uid={uid}")

    async def update(self, task_id: str, **kwargs) -> None:
        async with get_db_context() as db:
            row = await self._repo.update_fields(task_id, db, **kwargs)
            if not row:
                logger.warning(f"[TaskStore] task not found: {task_id}")

    async def get(self, task_id: str) -> Optional[dict]:
        async with get_db_context() as db:
            row = await self._repo.get_by_task_id(task_id, db)
            if not row:
                return None
            return {
                "task_id": row.task_id, "task_type": row.task_type,
                "target": row.target, "status": row.status,
                "progress": row.progress, "steps": row.steps,
                "result": row.result, "error": row.error,
                "created_at": row.created_at, "updated_at": row.updated_at,
                "completed_at": row.completed_at,
            }

    async def list_pending(self, task_type: str) -> list[dict]:
        async with get_db_context() as db:
            rows = await self._repo.list_pending(task_type, db)
            return [
                {"task_id": t.task_id, "task_type": t.task_type,
                 "target": t.target, "status": t.status}
                for t in rows
            ]
