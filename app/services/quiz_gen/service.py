"""Async LLM quiz generation service.

Business logic for /internal/quiz/generate-llm + /status. Generates quiz via
LLM in a background asyncio task, stores result in MongoDB. Idempotent by
task_id (repeated requests don't re-invoke the LLM).

Called by app/routers/internal_quiz.py (router only does param parsing).
"""

import asyncio
import time
from datetime import datetime, timedelta, timezone

from langchain_openai import ChatOpenAI
from loguru import logger
from pydantic import BaseModel, Field

from app.agent.task_quiz.prompts import QUIZ_GEN_SYS_PROMPT
from app.config import settings
from app.infra.mongo import coll, is_enabled
from app.services.quiz_task_service import (
    deliver_email,
    mark_generated,
    render_quiz_email,
    report_task_complete,
)

MAX_RETRIES = 3
QUIZ_COLLECTION = "task_quiz_questions"
_DIFFICULTY_LIMITS = {"easy": 600, "medium": 1200, "hard": 1800}

# Keep strong references to background tasks so asyncio doesn't GC them.
_background_tasks: set = set()


class QuizGenerateResult(BaseModel):
    """单题结构化输出 schema（一道任务可含多题）。"""

    question: str = Field(..., description="题干")
    question_type: str = Field(..., description="fill_blank / choice / short_answer")
    options: list[str] | None = Field(None, description="选择题选项；其他题型为空")
    answer: str = Field(..., description="正确答案")
    difficulty: str = Field(..., description="easy / medium / hard")
    answer_time_limit_seconds: int = Field(..., description="建议答题时限（秒）")


class QuizSetGenerateResult(BaseModel):
    """一道任务多题的结构化输出（LLM 一次返回 N 道题）。"""

    questions: list[QuizGenerateResult] = Field(..., min_length=1, max_length=5)


_QUESTION_FIELDS = (
    "question",
    "question_type",
    "options",
    "answer",
    "difficulty",
    "answer_time_limit_seconds",
)


def _quiz_from_doc(doc: dict) -> dict:
    """把题库文档归一化为 {questions: [...]}。

    新文档存 questions 数组；兼容历史单题文档（question 等平铺字段）。
    """
    qs = doc.get("questions")
    if isinstance(qs, list) and qs:
        return {"questions": qs}
    return {"questions": [{k: doc.get(k) for k in _QUESTION_FIELDS}]}


def _quiz_coll():
    if not is_enabled():
        raise RuntimeError("Mongo not configured (required for async quiz generation)")
    return coll(QUIZ_COLLECTION)


async def _get_quiz_doc(task_id: str) -> dict | None:
    doc = await _quiz_coll().find_one({"task_id": task_id})
    if doc:
        doc.pop("_id", None)
    return doc


def _quiz_from_doc(doc: dict) -> dict:
    """把题库文档归一化为 {questions: [...]}。

    新文档存 questions 数组；兼容历史单题文档（question 等平铺字段）。
    """
    qs = doc.get("questions")
    if isinstance(qs, list) and qs:
        return {"questions": qs}
    return {"questions": [{k: doc.get(k) for k in _QUESTION_FIELDS}]}


class QuizGenService:
    """Async + idempotent quiz generation. Called by the internal_quiz router."""

    @staticmethod
    async def generate(
        task_id: str, prompt: str, difficulty: str, uid: int | None, question_count: int = 1,
        user_email: str = "", cc_emails: list | None = None,
        incomplete_message: str | None = None,
    ) -> dict:
        """Returns {status: generating|ready, quiz?}. Launches background LLM if needed."""
        if not prompt.strip():
            raise ValueError("prompt required")
        if not 1 <= question_count <= 5:
            raise ValueError("question_count must be 1..5")
        if not settings.openai_api_key:
            raise RuntimeError("LLM not configured (openai_api_key empty)")

        existing = await _get_quiz_doc(task_id)
        if existing:
            status = existing.get("status", "ready")
            if status == "ready":
                logger.info("[INTERNAL_QUIZ] idempotent hit task_id={} (ready)", task_id)
                return {"status": "ready", "quiz": _quiz_from_doc(existing)}
            if status == "generating":
                logger.info("[INTERNAL_QUIZ] idempotent hit task_id={} (generating)", task_id)
                return {"status": "generating"}
            # status == failed -> delete old doc and re-generate
            await _quiz_coll().delete_one({"task_id": task_id})
            logger.info("[INTERNAL_QUIZ] re-generating failed task_id={}", task_id)

        await _quiz_coll().insert_one({
            "task_id": task_id, "uid": uid,
            "status": "generating", "created_at": time.time(),
        })
        task = asyncio.create_task(_generate_quiz_bg(
            task_id, prompt, difficulty, uid, question_count,
            user_email, cc_emails, incomplete_message,
        ))
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)
        logger.info("[INTERNAL_QUIZ] started generation task_id={} difficulty={} count={}", task_id, difficulty, question_count)
        return {"status": "generating"}

    @staticmethod
    async def get_status(task_id: str) -> dict:
        doc = await _get_quiz_doc(task_id)
        if not doc:
            logger.info("[INTERNAL_QUIZ] status task_id={} -> generating (no doc)", task_id)
            return {"status": "generating"}
        status = doc.get("status", "ready")
        logger.info("[INTERNAL_QUIZ] status task_id={} -> {}", task_id, status)
        if status == "ready":
            return {"status": "ready", "quiz": _quiz_from_doc(doc)}
        if status == "failed":
            return {"status": "failed", "error": doc.get("error", "unknown")}
        return {"status": "generating"}


async def _generate_quiz_bg(
    task_id: str, prompt: str, difficulty: str, uid: int | None, question_count: int,
    user_email: str = "", cc_emails: list | None = None,
    incomplete_message: str | None = None,
):
    """Background coroutine: invoke LLM and store result in Mongo."""
    try:
        llm = ChatOpenAI(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url or None,
            model=settings.llm_model,
            temperature=0.7,
        )
        structured_llm = llm.with_structured_output(QuizSetGenerateResult)

        last_err: Exception | None = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                result: QuizSetGenerateResult = await structured_llm.ainvoke(
                    [
                        {"role": "system", "content": QUIZ_GEN_SYS_PROMPT},
                        {
                            "role": "user",
                            "content": f"出题方向：{prompt}\n难度：{difficulty}\n出题数量：{question_count}",
                        },
                    ]
                )
                if not result.questions:
                    raise ValueError("LLM returned empty questions")
                # 任务级答题时限取第一题的建议值（各题可能不同，deadline 是任务级的）
                limit = int(result.questions[0].answer_time_limit_seconds)
                if limit <= 0:
                    limit = _DIFFICULTY_LIMITS.get(result.questions[0].difficulty, 1200)
                logger.info(
                    "[INTERNAL_QUIZ] generated task_id={} count={} difficulty={} (attempt={})",
                    task_id, len(result.questions), result.questions[0].difficulty, attempt,
                )
                await _quiz_coll().update_one(
                    {"task_id": task_id},
                    {"$set": {
                        "status": "ready",
                        "questions": [q.model_dump() for q in result.questions],
                        "difficulty": result.questions[0].difficulty,
                        "generated_at": time.time(),
                    }},
                )
                # 业务收尾（executor 侧）：更新业务行 + 发题目邮件（经 app-task）+ 报告 task 完成
                try:
                    qs = [q.model_dump() for q in result.questions]
                    limit = int(qs[0]["answer_time_limit_seconds"] or 0)
                    if limit <= 0:
                        limit = _DIFFICULTY_LIMITS.get(qs[0].get("difficulty", "medium"), 1200)
                    deadline = datetime.now(timezone.utc) + timedelta(seconds=limit)
                    await mark_generated(task_id, deadline, len(qs))
                    deadline_bj = (deadline + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M")
                    subject, body = render_quiz_email(prompt, qs, f"{deadline_bj}（北京时间）")
                    if user_email:
                        await deliver_email([user_email], cc_emails or [], subject, body, task_id)
                    await report_task_complete(task_id, "completed", f"quiz ready ({len(qs)}q)")
                except Exception as notify_err:
                    logger.warning("[INTERNAL_QUIZ] post-generation notify failed task_id={}: {}", task_id, notify_err)
                return
            except Exception as e:
                last_err = e
                logger.warning(
                    "[INTERNAL_QUIZ] attempt {}/{} failed task_id={}: {}",
                    attempt, MAX_RETRIES, task_id, e,
                )

        logger.error("[INTERNAL_QUIZ] all retries failed task_id={} err={}", task_id, last_err)
        await _quiz_coll().update_one(
            {"task_id": task_id},
            {"$set": {"status": "failed", "error": str(last_err), "failed_at": time.time()}},
        )
    except Exception as e:
        logger.exception("[INTERNAL_QUIZ] background generation crashed task_id={}", task_id)
        try:
            await _quiz_coll().update_one(
                {"task_id": task_id},
                {"$set": {"status": "failed", "error": str(e)}},
            )
        except Exception:
            pass
