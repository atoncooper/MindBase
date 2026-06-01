"""
Quiz router — question generation, submission, grading, history, export.
"""
import json

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Body, Depends, BackgroundTasks
from fastapi.responses import StreamingResponse
from loguru import logger

from app.services.quiz_generator import QuizGeneratorService, get_quiz_set, get_quiz_questions, get_quiz_questions_full
from app.services.quiz_grader import QuizGraderService
from app.services.quiz_export import QuizDataExportService
from app.database import get_db_context
from app.routers.auth import get_current_uid

router = APIRouter(prefix="/quiz", tags=["quiz"])


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
    pages: Optional[list[dict]] = Body(None, description="page list"),
    question_count: int = Query(10, ge=1, le=50),
    difficulty: str = Query("medium", pattern="^(easy|medium|hard)$"),
    title: Optional[str] = Query(None),
    uid: int = Depends(get_current_uid),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    """Generate a quiz set — creates row immediately, processes in background.

    Frontend should poll GET /quiz/{quiz_uuid} until status becomes "done" or "failed".
    """
    fids = [int(x.strip()) for x in folder_ids.split(",") if x.strip()] if folder_ids else []
    if not fids and not pages:
        raise HTTPException(400, "请提供 folder_ids 或 pages")

    service = QuizGeneratorService()
    quiz_uuid = await service.create_quiz_set(
        uid=uid,
        folder_ids=fids if fids else None,
        pages=pages,
        question_count=question_count,
        difficulty=difficulty,
        title=title,
    )

    background_tasks.add_task(
        _run_quiz_generation,
        quiz_uuid=quiz_uuid,
        uid=uid,
        folder_ids=fids if fids else None,
        pages=pages,
        question_count=question_count,
        difficulty=difficulty,
        title=title,
    )

    return {
        "quiz_uuid": quiz_uuid,
        "status": "generating",
    }


async def _run_quiz_generation(
    quiz_uuid: str,
    uid: int,
    folder_ids: Optional[list[int]],
    pages: Optional[list[dict]],
    question_count: int,
    difficulty: str,
    title: Optional[str] = None,
):
    """Background task: generate quiz via LLM and save to MongoDB."""
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


@router.post("/submit")
async def submit_quiz(body: dict, uid: int = Depends(get_current_uid)):
    """Submit answers and grade immediately."""
    quiz_uuid = body.get("quiz_uuid")
    answers = body.get("answers", [])
    time_spent = body.get("time_spent_seconds")

    if not quiz_uuid:
        raise HTTPException(400, "缺少 quiz_uuid")

    if not answers:
        raise HTTPException(400, "缺少 answers")

    service = QuizGraderService()
    try:
        result = await service.submit_and_grade(
            quiz_uuid=quiz_uuid,
            uid=uid,
            answers=answers,
            time_spent_seconds=time_spent,
        )
        return result
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.exception("[QUIZ] submit failed")
        raise HTTPException(500, f"批改失败: {e}")


# ── GET routes (specific paths BEFORE parameterized) ────────────


@router.get("/history")
async def get_history(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=100),
    uid: int = Depends(get_current_uid),
):
    """Get quiz history for the current user.

    Cross-store consistency: if a quiz_set has status='done' but MongoDB
    has 0 questions, mark it as failed and exclude from results.
    """
    async with get_db_context() as db:
        from sqlalchemy import text, select as sa_select
        from app.models import QuizSet
        from app.repository import mongo_quiz_repository as mongo_quiz

        # 1. Check for stale quiz sets (MySQL done but MongoDB empty)
        stale_result = await db.execute(
            sa_select(QuizSet.quiz_uuid).where(
                QuizSet.uid == uid,
                QuizSet.status == "done",
            )
        )
        stale_uuids = [row[0] for row in stale_result.all()]
        for qid in stale_uuids:
            try:
                mq_count = await mongo_quiz.count_questions(qid)
                if mq_count == 0:
                    qs_result = await db.execute(
                        sa_select(QuizSet).where(QuizSet.quiz_uuid == qid)
                    )
                    qs = qs_result.scalar_one_or_none()
                    if qs:
                        qs.status = "failed"
                        qs.error_message = "MongoDB data lost — questions not found"
            except Exception:
                pass  # MongoDB unavailable — skip check
        await db.commit()

        # 2. Count and paginate
        count_result = await db.execute(
            text(
                """SELECT COUNT(*) FROM quiz_sets
                   WHERE uid = :uid AND status IN ('done', 'failed')"""
            ),
            {"uid": uid},
        )
        total = count_result.scalar()

        offset = (page - 1) * page_size
        result = await db.execute(
            text(
                """SELECT qs.quiz_uuid, qs.title, qs.question_count,
                          qs.difficulty, qs.status, qs.source_type,
                          qs.created_at,
                          qsub.submission_uuid, qsub.total_score,
                          qsub.is_passed, qsub.correct_count,
                          qsub.total_question_count, qsub.time_spent_seconds,
                          qsub.submitted_at
                   FROM quiz_sets qs
                   LEFT JOIN quiz_submissions qsub
                     ON qsub.quiz_uuid = qs.quiz_uuid AND qsub.uid = :uid
                   WHERE qs.uid = :uid
                     AND qs.status IN ('done', 'failed')
                   ORDER BY qs.created_at DESC
                   LIMIT :limit OFFSET :offset"""
            ),
            {"uid": uid, "limit": page_size, "offset": offset},
        )
        submissions = []
        for row in result.fetchall():
            d = dict(row._mapping)
            submissions.append({
                "submission_uuid": d["submission_uuid"],
                "quiz_uuid": d["quiz_uuid"],
                "title": d["title"],
                "status": d["status"],
                "question_count": d["question_count"],
                "difficulty": d["difficulty"],
                "source_type": d["source_type"],
                "score": d["total_score"],
                "passed": bool(d["is_passed"]) if d["is_passed"] is not None else None,
                "correct_count": d["correct_count"],
                "total_question_count": d["total_question_count"],
                "time_spent_seconds": d["time_spent_seconds"],
                "submitted_at": d["submitted_at"],
                "created_at": str(d["created_at"]) if d["created_at"] else "",
            })

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
    async with get_db_context() as db:
        from sqlalchemy import text

        sql = """
            SELECT qq.question_uuid, qq.quiz_uuid, qq.question_type,
                   qq.question_text, qq.options,
                   qa.user_answer, qa.correct_answer_snapshot,
                   qq.explanation,
                   COUNT(qa.id) as times_wrong,
                   MAX(qa.submitted_at) as last_attempt_at
            FROM quiz_answers qa
            JOIN quiz_submissions qsub ON qsub.submission_uuid = qa.submission_uuid
            JOIN quiz_questions qq ON qq.question_uuid = qa.question_uuid
            WHERE qsub.uid = :uid AND qa.is_correct = 0
        """

        params = {"uid": uid}
        if folder_ids:
            fids = [int(x.strip()) for x in folder_ids.split(",") if x.strip()]
            folder_conditions = []
            for i, fid in enumerate(fids):
                param_name = f"fid_{i}"
                folder_conditions.append(f"qs.folder_ids LIKE :{param_name}")
                params[param_name] = f'%{fid}%'
            if folder_conditions:
                sql = """
                    SELECT qq.question_uuid, qq.quiz_uuid, qq.question_type,
                           qq.question_text, qq.options,
                           qa.user_answer, qa.correct_answer_snapshot,
                           qq.explanation,
                           COUNT(qa.id) as times_wrong,
                           MAX(qa.submitted_at) as last_attempt_at
                    FROM quiz_answers qa
                    JOIN quiz_submissions qsub ON qsub.submission_uuid = qa.submission_uuid
                    JOIN quiz_questions qq ON qq.question_uuid = qa.question_uuid
                    JOIN quiz_sets qs ON qs.quiz_uuid = qsub.quiz_uuid
                    WHERE qsub.uid = :uid AND qa.is_correct = 0
                """ + (" AND (" + " OR ".join(folder_conditions) + ")")

        sql += " GROUP BY qq.question_uuid ORDER BY last_attempt_at DESC"

        result = await db.execute(text(sql), params)
        wrong_answers = []
        import json as _json
        for row in result.fetchall():
            d = dict(row._mapping)
            user_answer = _json.loads(d["user_answer"]) if d["user_answer"] else d["user_answer"]
            correct_answer = _json.loads(d["correct_answer_snapshot"]) if d["correct_answer_snapshot"] else d["correct_answer_snapshot"]
            options_data = _json.loads(d["options"]) if isinstance(d.get("options"), str) else d.get("options")

            wrong_answers.append({
                "question_uuid": d["question_uuid"],
                "quiz_uuid": d["quiz_uuid"],
                "question_type": d["question_type"],
                "question_text": d["question_text"],
                "options": options_data,
                "user_answer": user_answer,
                "correct_answer": correct_answer,
                "explanation": d["explanation"],
                "times_wrong": d["times_wrong"],
                "last_attempt_at": d["last_attempt_at"],
            })

        return {"wrong_answers": wrong_answers, "total": len(wrong_answers)}


@router.get("/export")
async def export_quiz_data(
    format: str = Query("jsonl", pattern="^(jsonl|csv|sft)$"),
    folder_ids: Optional[str] = Query(None, description="comma-separated folder IDs"),
    uid: int = Depends(get_current_uid),
):
    """Export quiz training data as a streaming response."""
    fids = [int(x.strip()) for x in folder_ids.split(",") if x.strip()] if folder_ids else None

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


# ── Parameterized routes (MUST be last) ────────────────────────


@router.get("/{quiz_uuid}")
async def get_quiz(quiz_uuid: str, include_answers: bool = Query(False)):
    """获取题目集（不含答案用于答题，include_answers=true 含答案用于下载/回看）"""
    quiz_set = await get_quiz_set(quiz_uuid)
    if not quiz_set:
        raise HTTPException(404, "题目集不存在")

    questions = await (get_quiz_questions_full(quiz_uuid) if include_answers else get_quiz_questions(quiz_uuid))

    # Only flag as lost if status is "done" but MongoDB is empty.
    # "generating" means the background LLM task hasn't finished yet — that's expected.
    if quiz_set.status == "done" and quiz_set.question_count > 0 and len(questions) == 0:
        logger.warning(
            f"[QUIZ] quiz_uuid={quiz_uuid} has status=done question_count={quiz_set.question_count} "
            f"but MongoDB returned 0 questions — marking quiz as failed (data lost after migration?)"
        )
        async with get_db_context() as db:
            from app.models import QuizSet
            result = await db.execute(
                __import__("sqlalchemy").select(QuizSet).where(QuizSet.quiz_uuid == quiz_uuid)
            )
            qs = result.scalar_one_or_none()
            if qs:
                qs.status = "failed"
                qs.error_message = "MongoDB data lost — questions not found"
                await db.commit()
        raise HTTPException(410, "题目数据已丢失，请重新生成")

    return {
        "quiz_uuid": quiz_set.quiz_uuid,
        "title": quiz_set.title,
        "status": quiz_set.status,
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
                    if include_answers else {}
                ),
            }
            for q in questions
        ],
    }
