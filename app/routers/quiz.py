"""
Quiz router — question generation, submission, grading, history, export.
"""

import json
import re

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Body, Depends, BackgroundTasks, Response
from fastapi.responses import StreamingResponse
from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db, get_db_context
from app.response.quiz import QuizGeneratePage, QuizSubmissionRequest
from app.routers.auth import get_current_uid
from app.services.quiz_delete import QuizDeleteError, QuizDeleteService
from app.services.quiz_generator import (
    QuizGeneratorService,
    get_quiz_set,
    get_quiz_questions,
    get_quiz_questions_full,
)
from app.services.quiz_grader import QuizGraderService
from app.services.quiz_export import QuizDataExportService
from app.services.quiz_share_service import get_quiz_share_service

router = APIRouter(prefix="/quiz", tags=["quiz"])


_FOLDER_IDS_PATTERN = re.compile(r"^\d+(,\d+)*$")
_UUID_PATTERN = re.compile(r"^[a-f0-9-]{36}$")


def _parse_folder_ids(folder_ids: Optional[str]) -> list[int]:
    """Parse and validate comma-separated folder IDs query parameter."""
    if not folder_ids:
        return []
    if not _FOLDER_IDS_PATTERN.match(folder_ids):
        raise HTTPException(400, "folder_ids 格式非法")
    return [int(x.strip()) for x in folder_ids.split(",") if x.strip()]


def _parse_json_field(value: Any) -> Any:
    """Parse a JSON string field, falling back to the raw value.
    Handles both JSON-encoded strings (old MySQL format) and native values (MongoDB).
    """
    if value is None:
        return None
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return value


# ── POST routes ──────────────────────────────────────────────────


@router.post("/generate")
async def generate_quiz(
    folder_ids: Optional[str] = Query(None, description="comma-separated folder IDs"),
    pages: Optional[list[QuizGeneratePage]] = Body(None, description="page list"),
    question_count: int = Query(10, ge=1, le=50),
    difficulty: str = Query("medium", pattern="^(easy|medium|hard)$"),
    title: Optional[str] = Query(None),
    uid: int = Depends(get_current_uid),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    """Generate a quiz set — creates row immediately, processes in background.

    Frontend should poll GET /quiz/{quiz_uuid} until status becomes "done" or "failed".
    """
    fids = _parse_folder_ids(folder_ids)
    if not fids and not pages:
        raise HTTPException(400, "请提供 folder_ids 或 pages")

    # Preflight: verify enough retrievable chunks exist before creating the
    # quiz row, so the user gets an immediate 400 instead of polling for 30s
    # only to see a generation failure.
    from app.services.quiz_preflight import preflight_check

    preflight = await preflight_check(
        folder_ids=fids if fids else None,
        pages=[p.model_dump() for p in pages] if pages else None,
        question_count=question_count,
    )
    if not preflight.ok:
        raise HTTPException(400, preflight.reason)

    # Per-uid daily quota — fail-open if Redis is down.
    from app.services.llm.quiz_quota import QuizQuotaExceeded, check_and_consume

    try:
        await check_and_consume(uid, "generate")
    except QuizQuotaExceeded as e:
        raise HTTPException(429, f"今日出题次数已达上限（{e.limit} 次/天）")

    pages_payload = [p.model_dump() for p in pages] if pages else None

    service = QuizGeneratorService()
    quiz_uuid = await service.create_quiz_set(
        uid=uid,
        folder_ids=fids if fids else None,
        pages=pages_payload,
        question_count=question_count,
        difficulty=difficulty,
        title=title,
    )

    from app.services.quiz_queue import enqueue_generation

    enqueue_generation(
        background_tasks,
        quiz_uuid=quiz_uuid,
        uid=uid,
        folder_ids=fids if fids else None,
        pages=pages_payload,
        question_count=question_count,
        difficulty=difficulty,
        title=title,
    )

    return {
        "quiz_uuid": quiz_uuid,
        "status": "generating",
    }


@router.post("/submit")
async def submit_quiz(
    body: QuizSubmissionRequest, uid: int = Depends(get_current_uid)
):
    """Submit answers and grade immediately."""
    if not body.answers:
        raise HTTPException(400, "缺少 answers")

    from app.services.llm.quiz_quota import QuizQuotaExceeded, check_and_consume

    try:
        await check_and_consume(uid, "grade")
    except QuizQuotaExceeded as e:
        raise HTTPException(429, f"今日批改次数已达上限（{e.limit} 次/天）")

    service = QuizGraderService()
    try:
        result = await service.submit_and_grade(
            quiz_uuid=body.quiz_uuid,
            uid=uid,
            answers=[a.model_dump() for a in body.answers],
            time_spent_seconds=body.time_spent_seconds,
        )
        return result
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception:
        logger.exception("[QUIZ] submit failed")
        raise HTTPException(500, "批改服务异常，请稍后重试")


# ── GET routes (specific paths BEFORE parameterized) ────────────


@router.get("/history")
async def get_history(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=100),
    uid: int = Depends(get_current_uid),
):
    """Get quiz history for the current user.

    Cross-store consistency: stale ``generating`` quizzes past the timeout
    are marked failed, and ``done`` quizzes with no MongoDB questions are
    marked lost, before listing.
    """
    from app.services.quiz_lifecycle import refresh_stale_quiz_states
    from app.repository.quiz_repository import get_quiz_repository

    repo = get_quiz_repository()
    async with get_db_context() as db:
        await refresh_stale_quiz_states(uid, db)
        total = await repo.count_history(uid, db)
        submissions = await repo.list_history(uid, page, page_size, db)

    offset = (page - 1) * page_size
    return {
        "submissions": submissions,
        "total": total,
        "page": page,
        "page_size": page_size,
        "has_more": offset + page_size < total,
    }


@router.get("/wrong-answers")
async def get_wrong_answers(
    folder_ids: Optional[str] = Query(None),
    uid: int = Depends(get_current_uid),
):
    """Get wrong-answer notebook for the current user."""
    fids = _parse_folder_ids(folder_ids) or None

    from app.repository.quiz_repository import get_quiz_repository

    repo = get_quiz_repository()
    async with get_db_context() as db:
        wrong_answers = await repo.list_wrong_answers(uid, fids, db)

    return {"wrong_answers": wrong_answers, "total": len(wrong_answers)}


@router.get("/export")
async def export_quiz_data(
    format: str = Query("jsonl", pattern="^(jsonl|csv|sft)$"),
    folder_ids: Optional[str] = Query(None, description="comma-separated folder IDs"),
    uid: int = Depends(get_current_uid),
):
    """Export quiz training data as a streaming response."""
    fids = _parse_folder_ids(folder_ids) or None

    service = QuizDataExportService()

    async def generate():
        async for row in service.export_submissions(uid, fids, format):
            yield row

    content_type = {
        "jsonl": "application/jsonl",
        "csv": "text/csv",
        "sft": "application/jsonl",
    }[format]

    filename = f"quiz_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.{format}"

    return StreamingResponse(
        generate(),
        media_type=content_type,
        headers={
            "Content-Disposition": f"attachment; filename={filename}",
            "Cache-Control": "no-cache",
        },
    )


# ── Sharing (public read + owner-managed write) ─────────────────


@router.post("/{quiz_uuid}/share")
async def create_quiz_share(
    quiz_uuid: str,
    body: dict = Body(default_factory=dict),
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Create or rotate the share_token for an owned quiz.

    Body: ``{"expires_in_days": int | null}``. ``null``/absent = never expires.
    Returns ``{quiz_uuid, share_token, shared_at, share_expires_at}``.
    Re-issuing invalidates the previous link.
    """
    expires_in_days = body.get("expires_in_days") if isinstance(body, dict) else None
    if expires_in_days is not None:
        try:
            expires_in_days = int(expires_in_days)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="expires_in_days 必须是整数或 null")
    service = get_quiz_share_service()
    return await service.create_share(quiz_uuid, uid, db, expires_in_days)


@router.get("/{quiz_uuid}/share")
async def get_quiz_share_status(
    quiz_uuid: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Owner-side query: current share state for an owned quiz."""
    service = get_quiz_share_service()
    return await service.get_share_status(quiz_uuid, uid, db)


@router.delete("/{quiz_uuid}/share")
async def revoke_quiz_share(
    quiz_uuid: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Revoke sharing for an owned quiz. Idempotent."""
    service = get_quiz_share_service()
    return await service.revoke_share(quiz_uuid, uid, db)


@router.get("/shared/{share_token}")
async def get_shared_quiz(
    share_token: str,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """Public read of a shared quiz — NO authentication required.

    Returns quiz questions WITHOUT correct answers / explanations / keywords
    so viewers can self-test. Raises 404 for invalid / revoked / non-shareable
    tokens (identical response to avoid state enumeration).

    Response is cacheable for 60s at the browser and at nginx (separate
    ``proxy_cache`` directive). Revocation / re-issuance takes effect
    immediately at the Redis L2 layer; worst-case staleness at the HTTP
    layers is bounded by the 60s TTL — acceptable for non-sensitive content.
    """
    response.headers["Cache-Control"] = "public, max-age=60"
    response.headers["Vary"] = "Accept-Encoding"
    service = get_quiz_share_service()
    return await service.get_shared_quiz(share_token, db)


# ── Parameterized routes (MUST be last) ────────────────────────


@router.delete("/{quiz_uuid}")
async def delete_quiz(
    quiz_uuid: str,
    uid: int = Depends(get_current_uid),
):
    service = QuizDeleteService()
    try:
        return await service.delete_quiz(quiz_uuid=quiz_uuid, uid=uid)
    except QuizDeleteError as e:
        raise HTTPException(e.status_code, e.detail) from e


@router.get("/{quiz_uuid}")
async def get_quiz(
    quiz_uuid: str,
    include_answers: bool = Query(False),
    uid: int = Depends(get_current_uid),
):
    """获取题目集（不含答案用于答题，include_answers=true 含答案用于下载/回看）"""
    # Refresh stale states (timeout / lost) before reading — best-effort.
    try:
        from app.services.quiz_lifecycle import refresh_on_read

        async with get_db_context() as db:
            await refresh_on_read(quiz_uuid, uid, db)
    except Exception as e:
        logger.warning(f"[QUIZ] refresh_on_read skipped quiz_uuid={quiz_uuid}: {e}")

    quiz_set = await get_quiz_set(quiz_uuid)
    if not quiz_set or quiz_set.uid != uid or quiz_set.status == "deleting":
        raise HTTPException(404, "题目集不存在")

    questions = await (
        get_quiz_questions_full(quiz_uuid)
        if include_answers
        else get_quiz_questions(quiz_uuid)
    )

    # Only flag as lost if status is "done"/"partial" but MongoDB is empty.
    # "generating" means the background LLM task hasn't finished yet — that's expected.
    if (
        quiz_set.status in ("done", "partial")
        and quiz_set.question_count > 0
        and len(questions) == 0
    ):
        logger.warning(
            f"[QUIZ] quiz_uuid={quiz_uuid} has status={quiz_set.status} "
            f"question_count={quiz_set.question_count} but MongoDB returned 0 questions "
            f"— marking quiz as failed (data lost after migration?)"
        )
        from app.repository.quiz_repository import get_quiz_repository

        async with get_db_context() as db:
            await get_quiz_repository().mark_quiz_lost(quiz_uuid, db)
        raise HTTPException(410, "题目数据已丢失，请重新生成")

    return {
        "quiz_uuid": quiz_set.quiz_uuid,
        "title": quiz_set.title,
        "status": quiz_set.status,
        "partial": quiz_set.status == "partial",
        "error_message": quiz_set.error_message,
        "question_count": quiz_set.question_count,
        "type_distribution": quiz_set.type_distribution,
        "difficulty": quiz_set.difficulty,
        "total_score": quiz_set.total_score,
        "passing_score": quiz_set.passing_score,
        "source_type": getattr(quiz_set, "source_type", "folder") or "folder",
        "source_pages": getattr(quiz_set, "source_pages", None),
        "created_at": str(quiz_set.created_at) if quiz_set.created_at else "",
        "questions": [
            {
                "question_uuid": q["question_uuid"],
                "question_type": q["question_type"],
                "difficulty": q["difficulty"],
                "question_text": q["question_text"],
                "options": _parse_json_field(q.get("options")),
                **(
                    {
                        "correct_answer": _parse_json_field(q.get("correct_answer")),
                        "explanation": q.get("explanation"),
                        "keywords": _parse_json_field(q.get("keywords")),
                    }
                    if include_answers
                    else {}
                ),
            }
            for q in questions
        ],
    }
