"""Quiz lifecycle service — stale-state cleanup and timeout handling.

Centralizes the cross-store consistency checks that were previously
scattered across repository and router. Pure orchestration: delegates
SQL to QuizRepository and doc counts to mongo_quiz_repository.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import QuizSet
from app.repository.quiz_repository import get_quiz_repository

# A quiz still in "generating" after this many minutes is considered stuck.
GENERATION_TIMEOUT_MINUTES = 10


def _utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def refresh_stale_quiz_states(uid: int, db: AsyncSession) -> None:
    """Best-effort cleanup of stale quiz states for a user.

    1. Marks ``generating`` quizzes older than GENERATION_TIMEOUT_MINUTES
       as ``failed`` with a timeout error message.
    2. Delegates the ``done``-but-MongoDB-empty check to the repository.

    Commits once at the end. Safe to call on any quiz read path.
    """
    cutoff = _utc_now_naive() - timedelta(minutes=GENERATION_TIMEOUT_MINUTES)

    timeout_result = await db.execute(
        select(QuizSet).where(
            QuizSet.uid == uid,
            QuizSet.status == "generating",
            QuizSet.created_at < cutoff,
        )
    )
    timed_out = timeout_result.scalars().all()
    for qs in timed_out:
        qs.status = "failed"
        qs.error_message = "generation timeout"
        logger.warning(
            f"[QUIZ_LIFECYCLE] marking timed-out quiz_uuid={qs.quiz_uuid} as failed"
        )

    # Delegate the done-but-empty check (existing logic).
    repo = get_quiz_repository()
    await repo.refresh_stale_quiz_sets(uid, db)

    await db.commit()


async def refresh_on_read(quiz_uuid: str, uid: int, db: AsyncSession) -> None:
    """Convenience: refresh stale states before reading a specific quiz.

    Cheaper than the uid-wide sweep when only one quiz is being accessed.
    """
    result = await db.execute(
        select(QuizSet).where(
            QuizSet.quiz_uuid == quiz_uuid, QuizSet.uid == uid
        )
    )
    qs = result.scalar_one_or_none()
    if qs and qs.status == "generating":
        cutoff = _utc_now_naive() - timedelta(minutes=GENERATION_TIMEOUT_MINUTES)
        if qs.created_at and qs.created_at.replace(tzinfo=None) < cutoff:
            qs.status = "failed"
            qs.error_message = "generation timeout"
            await db.commit()
            logger.warning(
                f"[QUIZ_LIFECYCLE] single-quiz timeout quiz_uuid={quiz_uuid}"
            )
