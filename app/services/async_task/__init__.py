"""
Async task management — subprocess cache + WebSocket streaming.

Architecture:
  subprocess (every 5 min) → query MySQL async_tasks → write shared cache
  main process (WebSocket) → read shared cache → push to clients
"""

from app.services.async_task.cache import (
    start_cache_refresher,
    stop_cache_refresher,
    get_cached_tasks,
    get_cached_task,
)
from app.services.async_task.service import TaskService

__all__ = [
    "start_cache_refresher",
    "stop_cache_refresher",
    "get_cached_tasks",
    "get_cached_task",
    "TaskService",
]
