"""Quiz generation task queue abstraction.

Wraps FastAPI BackgroundTasks as the default in-process executor and
exposes a pluggable interface for swapping in a real queue (RQ / Celery)
later. When Redis-backed queueing is enabled via ``quiz.queue.engine``,
enqueuing delegates to the configured backend; otherwise it falls back
to BackgroundTasks.

This module is the single switch point — router code calls
``enqueue_generation(background_tasks, ...)`` and stays backend-agnostic.
"""

from __future__ import annotations

from typing import Optional

from fastapi import BackgroundTasks
from loguru import logger

from app.infra.config import config
from app.services.quiz_generator import QuizGeneratorService


def _queue_engine() -> str:
    return config.quiz.queue.engine


async def _run_quiz_generation(
    quiz_uuid: str,
    uid: int,
    folder_ids: Optional[list[int]],
    pages: Optional[list[dict]],
    question_count: int,
    difficulty: str,
    title: Optional[str] = None,
) -> None:
    """Background task body: generate quiz via LLM and save to MongoDB."""
    try:
        service = QuizGeneratorService()
        await service.run_generation(
            quiz_uuid=quiz_uuid,
            uid=uid,
            folder_ids=folder_ids,
            pages=pages,
            question_count=question_count,
            difficulty=difficulty,
            title=title,
        )
    except Exception as e:
        logger.error(f"[QUIZ] background generation failed quiz_uuid={quiz_uuid}: {e}")


def enqueue_generation(
    background_tasks: BackgroundTasks,
    *,
    quiz_uuid: str,
    uid: int,
    folder_ids: Optional[list[int]],
    pages: Optional[list[dict]],
    question_count: int,
    difficulty: str,
    title: Optional[str] = None,
) -> None:
    """Enqueue a quiz generation task.

    Default backend: FastAPI BackgroundTasks (in-process). When
    ``quiz.queue.engine`` is set to ``rq`` or ``celery``, delegate to
    the corresponding backend (not yet implemented — logs a warning and
    falls back to BackgroundTasks).
    """
    engine = _queue_engine()
    if engine == "background":
        background_tasks.add_task(
            _run_quiz_generation,
            quiz_uuid=quiz_uuid,
            uid=uid,
            folder_ids=folder_ids,
            pages=pages,
            question_count=question_count,
            difficulty=difficulty,
            title=title,
        )
        return

    # RQ / Celery backends would be wired here. Until then, fall back.
    logger.warning(
        f"[QUIZ_QUEUE] engine={engine} not yet implemented, falling back to BackgroundTasks"
    )
    background_tasks.add_task(
        _run_quiz_generation,
        quiz_uuid=quiz_uuid,
        uid=uid,
        folder_ids=folder_ids,
        pages=pages,
        question_count=question_count,
        difficulty=difficulty,
        title=title,
    )
