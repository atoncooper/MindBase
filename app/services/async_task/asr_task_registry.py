"""In-memory registry for ASR task progress state.

Shared between ``routers/asr.py`` (task creation + status polling),
``routers/vector_page.py`` (vector pipeline triggers ASR and watches
the task), and ``services/asr_page_service.py`` /
``services/vector_page_service.py`` (the workers that mutate state).

Lifting this out of the router keeps the layering contract: services
must not import from routers.
"""

from __future__ import annotations

import uuid
from typing import Any, Optional

# task_id -> {"status", "progress", "message", "result", "uid"}
asr_tasks: dict[str, dict[str, Any]] = {}


def create_task(uid: Optional[int] = None) -> str:
    """Create a new pending task and return its id.

    ``uid`` is optional for backward compat with callers that predate the
    IDOR fix; when provided, polling endpoints can enforce ownership.
    """
    task_id = str(uuid.uuid4())
    asr_tasks[task_id] = {
        "status": "pending",
        "progress": 0,
        "message": "任务已创建",
        "result": None,
        "uid": uid,
    }
    return task_id


def get_task(task_id: str) -> dict[str, Any] | None:
    return asr_tasks.get(task_id)


def set_task(task_id: str, **fields: Any) -> None:
    """Partial update of a task entry."""
    task = asr_tasks.get(task_id)
    if task is None:
        return
    task.update(fields)
