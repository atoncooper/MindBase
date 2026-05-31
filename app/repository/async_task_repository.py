"""
AsyncTask CRUD repository — typed operations for async_tasks table.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import select, update, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AsyncTask


class AsyncTaskRepository:
    """Persistence for async_tasks."""

    async def create(
        self,
        task_id: str,
        task_type: str,
        target: dict,
        uid: int | None = None,
        db: AsyncSession | None = None,
    ) -> AsyncTask:
        task = AsyncTask(
            uid=uid,
            task_id=task_id,
            task_type=task_type,
            target=target,
            status="pending",
            progress=0,
            steps=[],
        )
        if db:
            db.add(task)
            await db.commit()
            await db.refresh(task)
        return task

    async def get_by_task_id(self, task_id: str, db: AsyncSession) -> Optional[AsyncTask]:
        result = await db.execute(
            select(AsyncTask).where(AsyncTask.task_id == task_id)
        )
        return result.scalar_one_or_none()

    async def update_fields(
        self, task_id: str, db: AsyncSession, **kwargs,
    ) -> Optional[AsyncTask]:
        row = await self.get_by_task_id(task_id, db)
        if not row:
            return None
        for k, v in kwargs.items():
            if hasattr(row, k):
                setattr(row, k, v)
        row.updated_at = datetime.utcnow()
        if kwargs.get("status") in ("done", "failed"):
            row.completed_at = datetime.utcnow()
        await db.commit()
        await db.refresh(row)
        return row

    async def update_steps(
        self,
        task_id: str,
        db: AsyncSession,
        *,
        name: str,
        status: str,
        progress: int = 0,
        result: dict | None = None,
        error: str | None = None,
    ) -> Optional[AsyncTask]:
        """Add or update a step entry in the steps JSON array."""
        row = await self.get_by_task_id(task_id, db)
        if not row:
            return None
        steps: list[dict] = list(row.steps or [])
        updated = False
        for s in steps:
            if s.get("name") == name:
                s["status"] = status
                s["progress"] = progress
                if result:
                    s["result"] = result
                if error:
                    s["error"] = error
                updated = True
                break
        if not updated:
            steps.append({"name": name, "status": status, "progress": progress,
                          "result": result, "error": error})
        row.steps = steps
        row.progress = progress
        row.updated_at = datetime.utcnow()
        await db.commit()
        await db.refresh(row)
        return row

    async def list_by_uid(
        self,
        uid: int,
        db: AsyncSession,
        task_type: str | None = None,
        status: str | None = None,
        limit: int = 50,
    ) -> list[AsyncTask]:
        stmt = select(AsyncTask).where(AsyncTask.uid == uid)
        if task_type:
            stmt = stmt.where(AsyncTask.task_type == task_type)
        if status:
            stmt = stmt.where(AsyncTask.status == status)
        stmt = stmt.order_by(AsyncTask.updated_at.desc()).limit(limit)
        result = await db.execute(stmt)
        return list(result.scalars().all())

    async def list_pending(self, task_type: str, db: AsyncSession) -> list[AsyncTask]:
        result = await db.execute(
            select(AsyncTask).where(
                AsyncTask.task_type == task_type,
                AsyncTask.status.in_(["pending", "processing"]),
            )
        )
        return list(result.scalars().all())

    async def count_by_uid(self, uid: int, db: AsyncSession) -> int:
        result = await db.execute(
            select(func.count()).where(AsyncTask.uid == uid)
        )
        return result.scalar() or 0


_repo: Optional[AsyncTaskRepository] = None


def get_async_task_repository() -> AsyncTaskRepository:
    global _repo
    if _repo is None:
        _repo = AsyncTaskRepository()
    return _repo
