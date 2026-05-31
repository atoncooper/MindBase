"""
TaskService — async task query & management.

Reads from shared cache (populated by subprocess), NOT from DB.
"""

from __future__ import annotations

from typing import Any

from app.services.async_task.cache import get_cached_tasks, get_cached_task


class TaskService:
    """Query async tasks from the in-memory cache."""

    def list_tasks(
        self,
        uid: int | None = None,
        task_type: str | None = None,
        status: str | None = None,
    ) -> list[dict[str, Any]]:
        return get_cached_tasks(uid=uid, task_type=task_type, status=status)

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        return get_cached_task(task_id)

    def list_by_user(
        self,
        uid: int,
        task_type: str | None = None,
    ) -> list[dict[str, Any]]:
        return get_cached_tasks(uid=uid, task_type=task_type)
