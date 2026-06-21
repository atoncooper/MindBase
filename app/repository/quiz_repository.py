"""Quiz query repository — MySQL read access + cross-store consistency checks.

Absorbs the raw SQL that previously lived inline in ``app/routers/quiz.py``.
All queries are parameterised; no user input is ever string-interpolated into
SQL text.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import text, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import QuizSet


class QuizRepository:
    """Data access for quiz_sets / quiz_submissions / quiz_answers queries."""

    # ── Cross-store consistency ───────────────────────────────────

    async def refresh_stale_quiz_sets(self, uid: int, db: AsyncSession) -> None:
        """Mark quiz_sets as failed when MySQL says 'done' but MongoDB has 0 questions.

        Best-effort: if MongoDB is unavailable the check is skipped silently.
        Mutates rows in-place and commits.
        """
        from app.repository import mongo_quiz_repository as mongo_quiz

        stale_result = await db.execute(
            select(QuizSet.quiz_uuid).where(
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
                        select(QuizSet).where(QuizSet.quiz_uuid == qid)
                    )
                    qs = qs_result.scalar_one_or_none()
                    if qs:
                        qs.status = "failed"
                        qs.error_message = "MongoDB data lost — questions not found"
            except Exception:
                # MongoDB unavailable — skip this quiz set.
                pass
        await db.commit()

    async def mark_quiz_lost(self, quiz_uuid: str, db: AsyncSession) -> None:
        """Flip a single quiz_set to 'failed' with a data-lost message."""
        result = await db.execute(
            select(QuizSet).where(QuizSet.quiz_uuid == quiz_uuid)
        )
        qs = result.scalar_one_or_none()
        if qs:
            qs.status = "failed"
            qs.error_message = "MongoDB data lost — questions not found"
            await db.commit()

    # ── History ───────────────────────────────────────────────────

    async def count_history(self, uid: int, db: AsyncSession) -> int:
        """Count quiz_sets with terminal status for the user."""
        result = await db.execute(
            text(
                "SELECT COUNT(*) FROM quiz_sets "
                "WHERE uid = :uid AND status IN ('done', 'failed')"
            ),
            {"uid": uid},
        )
        return int(result.scalar() or 0)

    async def list_history(
        self, uid: int, page: int, page_size: int, db: AsyncSession
    ) -> list[dict]:
        """Paginated history with LEFT JOIN to submissions.

        Returns one row per quiz_set; submission columns are NULL when the
        user has not submitted yet.
        """
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
        submissions: list[dict] = []
        for row in result.fetchall():
            d = dict(row._mapping)
            submissions.append(
                {
                    "submission_uuid": d["submission_uuid"],
                    "quiz_uuid": d["quiz_uuid"],
                    "title": d["title"],
                    "status": d["status"],
                    "question_count": d["question_count"],
                    "difficulty": d["difficulty"],
                    "source_type": d["source_type"],
                    "score": d["total_score"],
                    "passed": (
                        bool(d["is_passed"]) if d["is_passed"] is not None else None
                    ),
                    "correct_count": d["correct_count"],
                    "total_question_count": d["total_question_count"],
                    "time_spent_seconds": d["time_spent_seconds"],
                    "submitted_at": d["submitted_at"],
                    "created_at": str(d["created_at"]) if d["created_at"] else "",
                }
            )
        return submissions

    # ── Wrong-answer notebook ─────────────────────────────────────

    async def list_wrong_answers(
        self,
        uid: int,
        folder_ids: Optional[list[int]],
        db: AsyncSession,
    ) -> list[dict]:
        """Wrong-answer notebook, optionally filtered by folder_ids.

        ``folder_ids`` filtering uses parameterised ``LIKE :fid_N`` clauses —
        the param name is index-derived (never user input) and the value is
        ``%{int}%`` so there is no injection surface.
        """
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
            WHERE qsub.uid = :uid AND qa.is_correct = 0 AND qs.status = 'done'
        """
        params: dict[str, Any] = {"uid": uid}

        if folder_ids:
            folder_conditions: list[str] = []
            for i, fid in enumerate(folder_ids):
                param_name = f"fid_{i}"
                folder_conditions.append(f"qs.folder_ids LIKE :{param_name}")
                params[param_name] = f"%{fid}%"
            if folder_conditions:
                sql += " AND (" + " OR ".join(folder_conditions) + ")"

        sql += " GROUP BY qq.question_uuid ORDER BY last_attempt_at DESC"

        result = await db.execute(text(sql), params)
        wrong_answers: list[dict] = []
        for row in result.fetchall():
            d = dict(row._mapping)
            user_answer = (
                json.loads(d["user_answer"]) if d["user_answer"] else d["user_answer"]
            )
            correct_answer = (
                json.loads(d["correct_answer_snapshot"])
                if d["correct_answer_snapshot"]
                else d["correct_answer_snapshot"]
            )
            options_data = (
                json.loads(d["options"])
                if isinstance(d.get("options"), str)
                else d.get("options")
            )
            wrong_answers.append(
                {
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
                }
            )
        return wrong_answers

    # ── Sharing ───────────────────────────────────────────────────

    async def get_owned_quiz(
        self, quiz_uuid: str, uid: int, db: AsyncSession
    ) -> Optional[QuizSet]:
        """Fetch a quiz_set owned by ``uid``. Returns None if not found or
        not owned — callers should treat both as 404 to avoid leaking existence.
        """
        result = await db.execute(
            select(QuizSet).where(QuizSet.quiz_uuid == quiz_uuid, QuizSet.uid == uid)
        )
        return result.scalar_one_or_none()

    async def set_share_token(
        self,
        quiz_uuid: str,
        uid: int,
        share_token: str,
        db: AsyncSession,
        expires_at: Optional[datetime] = None,
    ) -> tuple[bool, Optional[str]]:
        """Set share_token on an owned quiz.

        Returns ``(success, previous_token)``. ``previous_token`` is the old
        share_token if one existed (so the caller can invalidate its cache
        entry), else None. Re-issuing replaces the previous token (old link
        becomes invalid). ``expires_at`` is an optional absolute expiry
        timestamp; None = no expiry.
        """
        result = await db.execute(
            select(QuizSet).where(QuizSet.quiz_uuid == quiz_uuid, QuizSet.uid == uid)
        )
        qs = result.scalar_one_or_none()
        if qs is None:
            return False, None
        previous = qs.share_token
        qs.share_token = share_token
        qs.shared_at = datetime.now(timezone.utc)
        qs.share_expires_at = expires_at
        await db.commit()
        return True, previous

    async def clear_share_token(
        self, quiz_uuid: str, uid: int, db: AsyncSession
    ) -> tuple[bool, Optional[str]]:
        """Revoke sharing on an owned quiz.

        Returns ``(success, previous_token)`` so the caller can invalidate
        the cache entry for the revoked token.
        """
        result = await db.execute(
            select(QuizSet).where(QuizSet.quiz_uuid == quiz_uuid, QuizSet.uid == uid)
        )
        qs = result.scalar_one_or_none()
        if qs is None:
            return False, None
        previous = qs.share_token
        qs.share_token = None
        qs.shared_at = None
        qs.share_expires_at = None
        await db.commit()
        return True, previous

    async def get_by_share_token(
        self, share_token: str, db: AsyncSession
    ) -> Optional[QuizSet]:
        """Fetch a quiz_set by its share_token. Returns None if not shared
        or token is invalid. No uid scoping — this is the public read path.
        """
        result = await db.execute(
            select(QuizSet).where(QuizSet.share_token == share_token)
        )
        return result.scalar_one_or_none()


# ── Module-level singleton ────────────────────────────────────────

_repo: Optional[QuizRepository] = None


def get_quiz_repository() -> QuizRepository:
    global _repo
    if _repo is None:
        _repo = QuizRepository()
    return _repo
