"""Quiz generation from a chat session summary — on-demand, not scheduled.

Flow (mirrors ``QuizGeneratorService.run_generation`` but sources material
from the session summary instead of Milvus chunks):

1. Ensure a summary exists via ``session_summary.get_or_create_summary``
   (reuses the registered ``summary`` agent; the persisted summary is
   shared with the summary modal).
2. Split the summary text into pseudo-chunks — ``generate_questions``
   only needs ``{"title", "content"}`` dicts, and ``validate_question``
   traces answers against chunk text (bvid-less chunks are fine; trace
   failures only downgrade to ``_low_confidence``).
3. Generate questions with the quiz agent core (``generate_questions``).
4. Persist into the regular quiz stores (MySQL ``quiz_sets`` with
   ``source_type="session_summary"`` + Mongo ``quiz_questions``), so the
   set shows up in the existing quiz page with full answer/grading support.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException
from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.quiz import generate_questions, validate_question
from app.database import get_db_context
from app.models import ChatSession, QuizSet
from app.repository import mongo_chat_repository as mongo_chat
from app.repository import mongo_quiz_repository as mongo_quiz
from app.services import chat_history as chat_history_service
from app.services.chat.llm import build_llm
from app.services.quiz_generator import _sanitize_error_message
from app.services.session_summary import get_or_create_summary

# Paragraphs are merged/split around this size to give each batch enough
# context without exceeding the quiz prompt's per-chunk cap.
CHUNK_TARGET_CHARS = 600
CHUNK_MAX_CHARS = 3000
MIN_SUMMARY_CHARS = 200


def split_summary_to_chunks(
    summary: str,
    *,
    target_chars: int = CHUNK_TARGET_CHARS,
    max_chunks: int = 20,
) -> list[dict]:
    """Split summary markdown into pseudo-chunks for question generation.

    Splits on blank lines, merges short paragraphs up to ``target_chars``,
    hard-splits overlong paragraphs, and drops fragments too short to quiz
    from. Chunk shape matches what ``generate_questions`` expects:
    ``{"title": ..., "content": ...}`` (no bvid — summary has no video
    provenance).
    """
    paragraphs = [p.strip() for p in summary.split("\n\n") if p.strip()]

    chunks: list[str] = []
    buf = ""
    for para in paragraphs:
        if len(para) > CHUNK_MAX_CHARS:
            if buf:
                chunks.append(buf)
                buf = ""
            for i in range(0, len(para), CHUNK_MAX_CHARS):
                piece = para[i : i + CHUNK_MAX_CHARS].strip()
                if piece:
                    chunks.append(piece)
            continue
        if buf and len(buf) + len(para) + 1 > target_chars:
            chunks.append(buf)
            buf = para
        else:
            buf = f"{buf}\n{para}".strip()
    if buf:
        chunks.append(buf)

    chunks = [c for c in chunks if len(c) >= 80][:max_chunks]
    return [{"title": "会话总结", "content": c} for c in chunks]


def default_type_distribution(question_count: int) -> dict[str, int]:
    """60% single choice / 20% multi choice / 20% short answer.

    No essay by default — grading essays needs more LLM calls and summary
    material is usually too compact for good essay questions.
    """
    single = max(1, round(question_count * 0.6))
    multi = max(1, question_count - single) if question_count > 1 else 0
    short = 0
    if question_count > 2:
        multi = max(1, round((question_count - single) / 2))
        short = question_count - single - multi
    dist = {"single_choice": single, "multi_choice": multi, "short_answer": short}
    total = sum(dist.values())
    if total != question_count:
        dist["single_choice"] += question_count - total
    return {k: v for k, v in dist.items() if v > 0}


class QuizFromSummaryService:
    """On-demand quiz generation from a chat session summary."""

    async def create_quiz_set(
        self,
        *,
        uid: int,
        chat_session_id: str,
        question_count: int,
        difficulty: str,
        title: Optional[str] = None,
    ) -> str:
        """Create the QuizSet row (status=generating), return quiz_uuid."""
        if not title:
            title = await self._default_title(chat_session_id)

        quiz_uuid = str(uuid.uuid4())
        async with get_db_context() as db:
            db.add(
                QuizSet(
                    quiz_uuid=quiz_uuid,
                    uid=uid,
                    title=title[:200],
                    question_count=question_count,
                    type_distribution=default_type_distribution(question_count),
                    difficulty=difficulty,
                    folder_ids=[],
                    source_type="session_summary",
                    source_pages=None,
                    chat_session_id=chat_session_id,
                    status="generating",
                )
            )
            await db.commit()
        return quiz_uuid

    @staticmethod
    async def _default_title(chat_session_id: str) -> str:
        try:
            async with get_db_context() as db:
                row = await db.execute(
                    select(ChatSession.title).where(
                        ChatSession.chat_session_id == chat_session_id
                    )
                )
                session_title = row.scalar_one_or_none()
        except Exception:
            logger.warning(
                "[QUIZ_SUMMARY] session title lookup failed session=%s",
                chat_session_id[:8],
            )
            session_title = None
        prefix = f"来自会话：{session_title}" if session_title else "会话总结题目"
        return f"{prefix} {datetime.now(timezone.utc).strftime('%m-%d %H:%M')}"

    async def run_generation(
        self,
        *,
        quiz_uuid: str,
        uid: int,
        chat_session_id: str,
        question_count: int,
        difficulty: str,
        agent_harness: Any,
    ) -> None:
        """Background: ensure summary → pseudo-chunks → generate → persist."""
        try:
            summary = await get_or_create_summary(uid, chat_session_id, agent_harness)
            if len(summary.strip()) < MIN_SUMMARY_CHARS:
                raise ValueError(
                    f"会话总结内容过短（{len(summary.strip())} 字），不足以出题"
                )

            chunks = split_summary_to_chunks(summary)
            if not chunks:
                raise ValueError("会话总结无法切分出有效内容，无法出题")

            def llm_factory(temperature: float):
                # Same construction as QuizGeneratorService._get_tracking_llm:
                # per-user credential + usage tracking, non-streaming so
                # structured-output tokens never leak into any SSE stream.
                llm = build_llm(uid=uid)
                llm.temperature = temperature
                return llm

            questions = await generate_questions(
                chunks=chunks,
                total_count=question_count,
                type_distribution=default_type_distribution(question_count),
                difficulty=difficulty,
                uid=uid,
                batch_size=5,
                llm_factory=llm_factory,
            )

            valid_questions = [q for q in questions if validate_question(q, chunks)]

            # Same 60% partial-degradation policy as folder-based generation.
            partial_threshold = max(1, int(question_count * 0.6))
            if len(valid_questions) < partial_threshold:
                raise RuntimeError(
                    f"有效题目数量不足: {len(valid_questions)} < {partial_threshold} (60% threshold)"
                )

            final_status = (
                "done" if len(valid_questions) >= question_count else "partial"
            )

            await mongo_quiz.delete_by_quiz(quiz_uuid, uid=uid)
            saved = await mongo_quiz.insert_questions(quiz_uuid, uid, valid_questions)
            if saved == 0 and valid_questions:
                raise RuntimeError("MongoDB unavailable — 0 questions saved")

            from app.agent.quiz.quality import compute_quiz_quality

            quality_metrics = compute_quiz_quality(
                valid_questions,
                chunks,
                default_type_distribution(question_count),
            )

            async with get_db_context() as db:
                result = await db.execute(
                    select(QuizSet).where(QuizSet.quiz_uuid == quiz_uuid)
                )
                qs = result.scalar_one_or_none()
                if qs:
                    qs.status = final_status
                    qs.question_count = len(valid_questions)
                    qs.bvid_count = 0
                    qs.completed_at = datetime.now(timezone.utc)
                    qs.quality_metrics = quality_metrics
                    await db.commit()

            logger.info(
                "[QUIZ_SUMMARY] generated quiz_uuid={} session={} questions={} summary_chars={}",
                quiz_uuid,
                chat_session_id[:8],
                len(valid_questions),
                len(summary),
            )

        except Exception as e:
            logger.error(
                "[QUIZ_SUMMARY] generation failed quiz_uuid={} session={}: {}",
                quiz_uuid,
                chat_session_id[:8],
                e,
            )
            try:
                await mongo_quiz.delete_by_quiz(quiz_uuid, uid=uid)
            except Exception as purge_err:
                logger.warning(
                    "[QUIZ_SUMMARY] mongo purge failed quiz_uuid={}: {}",
                    quiz_uuid,
                    purge_err,
                )
            async with get_db_context() as db:
                result = await db.execute(
                    select(QuizSet).where(QuizSet.quiz_uuid == quiz_uuid)
                )
                qs = result.scalar_one_or_none()
                if qs:
                    qs.status = "failed"
                    qs.error_message = _sanitize_error_message(str(e))
                    await db.commit()


async def prepare_summary_generation(
    db: AsyncSession,
    uid: int,
    chat_session_id: str,
    agent_harness: Any,
) -> None:
    """Pre-creation validation — mirrors ``session_summary.prepare_summary``.

    Raises HTTPException(404/400/503); must run before the quiz row is
    created so failures surface as real status codes, not poll-timeouts.
    """
    session = await chat_history_service.get_chat_session_for_user(
        db, uid, chat_session_id
    )
    if session is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if not await mongo_chat.session_has_messages(chat_session_id):
        raise HTTPException(status_code=400, detail="会话暂无消息，无法出题")
    if not (agent_harness and getattr(agent_harness, "started", False)):
        raise HTTPException(status_code=503, detail="Agent 服务未启动")


async def run_summary_quiz_generation(
    *,
    quiz_uuid: str,
    uid: int,
    chat_session_id: str,
    question_count: int,
    difficulty: str,
    agent_harness: Any,
) -> None:
    """Background task body — thin wrapper with a top-level guard."""
    try:
        service = QuizFromSummaryService()
        await service.run_generation(
            quiz_uuid=quiz_uuid,
            uid=uid,
            chat_session_id=chat_session_id,
            question_count=question_count,
            difficulty=difficulty,
            agent_harness=agent_harness,
        )
    except Exception as e:
        # run_generation already marks the row failed; this catches anything
        # thrown before/around it (e.g. construction) so BackgroundTasks
        # never re-raises into the event loop.
        logger.error(
            "[QUIZ_SUMMARY] background wrapper failed quiz_uuid={}: {}", quiz_uuid, e
        )
