"""
MongoDB repository for quiz questions.

MySQL quiz_sets stores metadata (quiz_uuid, uid, title, status).
MongoDB quiz_questions stores individual question documents keyed by question_uuid.

JSON fields (options, correct_answer, keywords, scoring_rubric) are stored as
JSON strings to maintain compatibility with quiz_grader / quiz.router which
expect the same format as the old MySQL rows.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from loguru import logger

from app.infra.mongo import coll, is_enabled

COLLECTION = "quiz_questions"


def _new_uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Write ──────────────────────────────────────────────────────────


async def insert_questions(
    quiz_uuid: str,
    uid: int,
    questions: list[dict],
) -> int:
    """Batch insert questions. Returns count inserted.

    Raises RuntimeError if MongoDB is disabled but questions were provided.
    """
    if not questions:
        return 0
    if not is_enabled():
        raise RuntimeError("MongoDB is not connected — quiz questions cannot be saved")

    docs = []
    for q in questions:
        # Serialize list/dict fields as JSON strings to match old MySQL format
        _options = q.get("options")
        _correct = q.get("correct_answer")
        _keywords = q.get("keywords")
        _rubric = q.get("scoring_rubric")

        docs.append(
            {
                "question_uuid": q.get("question_uuid", _new_uuid()),
                "quiz_uuid": quiz_uuid,
                "uid": uid,
                "question_type": q.get("type", q.get("question_type", "")),
                "difficulty": q.get("difficulty", "medium"),
                "question_text": q.get("question", q.get("question_text", "")),
                "options": (
                    json.dumps(_options)
                    if _options is not None and not isinstance(_options, str)
                    else _options
                ),
                "correct_answer": (
                    json.dumps(_correct) if not isinstance(_correct, str) else _correct
                ),
                "explanation": q.get("explanation"),
                "keywords": (
                    json.dumps(_keywords)
                    if _keywords is not None and not isinstance(_keywords, str)
                    else _keywords
                ),
                "answer_template": q.get("answer_template"),
                "model_answer": q.get("model_answer"),
                "scoring_rubric": (
                    json.dumps(_rubric)
                    if _rubric is not None and not isinstance(_rubric, str)
                    else _rubric
                ),
                "bvid": q.get("bvid"),
                "source_segment": q.get("source_segment"),
                "chunk_id": str(q.get("source_chunk_index", "")),
                "is_valid": True,
                "created_at": _now(),
            }
        )

    await coll(COLLECTION).insert_many(docs)
    logger.info(f"[MONGO_QUIZ] inserted {len(docs)} questions for {quiz_uuid}")
    return len(docs)


# ── Read ───────────────────────────────────────────────────────────


async def get_questions(quiz_uuid: str) -> list[dict]:
    """Get questions without answers (for quiz display)."""
    if not is_enabled():
        logger.warning(
            f"[MONGO_QUIZ] MongoDB disabled, cannot read questions for {quiz_uuid}"
        )
        return []

    cursor = coll(COLLECTION).find(
        {"quiz_uuid": quiz_uuid, "is_valid": True},
        {
            "question_uuid": 1,
            "question_type": 1,
            "difficulty": 1,
            "question_text": 1,
            "options": 1,
            "_id": 0,
        },
    )
    results = await cursor.to_list(length=200)
    logger.info(
        f"[MONGO_QUIZ] get_questions quiz_uuid={quiz_uuid} count={len(results)}"
    )
    return results


async def get_questions_full(quiz_uuid: str) -> list[dict]:
    """Get questions with answers (for grading / review)."""
    if not is_enabled():
        logger.warning(
            f"[MONGO_QUIZ] MongoDB disabled, cannot read full questions for {quiz_uuid}"
        )
        return []

    cursor = coll(COLLECTION).find(
        {"quiz_uuid": quiz_uuid, "is_valid": True},
        {"_id": 0},
    )
    results = await cursor.to_list(length=200)
    logger.info(
        f"[MONGO_QUIZ] get_questions_full quiz_uuid={quiz_uuid} count={len(results)}"
    )
    return results


async def count_questions(quiz_uuid: str) -> int:
    """Count questions for a quiz in MongoDB."""
    if not is_enabled():
        return -1  # MongoDB disabled → don't know
    return await coll(COLLECTION).count_documents(
        {"quiz_uuid": quiz_uuid, "is_valid": True}
    )


async def delete_by_quiz(
    quiz_uuid: str,
    *,
    uid: int,
    require_enabled: bool = False,
) -> int:
    """Delete all questions for a quiz. Returns deleted count."""
    if not is_enabled():
        if require_enabled:
            raise RuntimeError(
                "MongoDB is not connected — quiz questions cannot be deleted safely"
            )
        return 0
    result = await coll(COLLECTION).delete_many({"quiz_uuid": quiz_uuid, "uid": uid})
    logger.info(
        f"[MONGO_QUIZ] deleted {result.deleted_count} questions for {quiz_uuid} uid={uid}"
    )
    return result.deleted_count
