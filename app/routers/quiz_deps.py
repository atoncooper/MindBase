"""Shared FastAPI dependencies for quiz routers.

Centralizes ownership and state checks so that submit / delete / share / get
endpoints enforce consistent authorization. Raises 404 (not 403) on
non-owned or non-existent quizzes to avoid leaking existence.
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.quiz_generator import get_quiz_set


async def require_owned_quiz(
    quiz_uuid: str, uid: int, db: AsyncSession
):
    """Return the QuizSet if owned by ``uid`` and not being deleted.

    Raises 404 otherwise. ``deleting`` status is treated as not-found
    so the deletion flow stays opaque to race conditions.
    """
    quiz_set = await get_quiz_set(quiz_uuid)
    if not quiz_set or quiz_set.uid != uid or quiz_set.status == "deleting":
        raise HTTPException(404, "题目集不存在")
    return quiz_set


async def require_completed_quiz(
    quiz_uuid: str, uid: int, db: AsyncSession
):
    """Return the QuizSet if owned, not deleting, and ready for grading.

    ``done`` and ``partial`` are accepted; ``generating`` / ``failed`` /
    ``lost`` are rejected with 400 so the client knows to retry or wait.
    """
    quiz_set = await require_owned_quiz(quiz_uuid, uid, db)
    if quiz_set.status not in ("done", "partial"):
        raise HTTPException(400, "题目尚未生成完成")
    return quiz_set
