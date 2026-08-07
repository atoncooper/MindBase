"""Async LLM quiz generation service.

Business logic for /internal/quiz/generate-llm + /status. Generates quiz via
LLM in a background asyncio task, stores result in MongoDB. Idempotent by
task_id (repeated requests don't re-invoke the LLM).

Called by app/routers/internal_quiz.py (router only does param parsing).
"""

import asyncio
import time

from langchain_openai import ChatOpenAI
from loguru import logger
from pydantic import BaseModel, Field

from app.agent.task_quiz.prompts import QUIZ_GEN_SYS_PROMPT
from app.config import settings
from app.infra.mongo import coll, is_enabled

MAX_RETRIES = 3
QUIZ_COLLECTION = "task_quiz_questions"
_DIFFICULTY_LIMITS = {"easy": 600, "medium": 1200, "hard": 1800}

# Keep strong references to background tasks so asyncio doesn't GC them.
_background_tasks: set = set()


class QuizGenerateResult(BaseModel):
    """Structured output schema enforced on the LLM."""

    question: str = Field(..., description="题干")
    question_type: str = Field(..., description="fill_blank / choice / short_answer")
    options: list[str] | None = Field(None, description="选择题选项；其他题型为空")
    answer: str = Field(..., description="正确答案")
    difficulty: str = Field(..., description="easy / medium / hard")
    answer_time_limit_seconds: int = Field(..., description="建议答题时限（秒）")


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
    return {
        "question": doc.get("question"),
        "question_type": doc.get("question_type"),
        "options": doc.get("options"),
        "answer": doc.get("answer"),
        "difficulty": doc.get("difficulty"),
        "answer_time_limit_seconds": doc.get("answer_time_limit_seconds"),
    }


class QuizGenService:
    """Async + idempotent quiz generation. Called by the internal_quiz router."""

    @staticmethod
    async def generate(task_id: str, prompt: str, difficulty: str, uid: int | None) -> dict:
        """Returns {status: generating|ready, quiz?}. Launches background LLM if needed."""
        if not prompt.strip():
            raise ValueError("prompt required")
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
        task = asyncio.create_task(_generate_quiz_bg(task_id, prompt, difficulty, uid))
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)
        logger.info("[INTERNAL_QUIZ] started generation task_id={} difficulty={}", task_id, difficulty)
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


async def _generate_quiz_bg(task_id: str, prompt: str, difficulty: str, uid: int | None):
    """Background coroutine: invoke LLM and store result in Mongo."""
    try:
        llm = ChatOpenAI(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url or None,
            model=settings.llm_model,
            temperature=0.7,
        )
        structured_llm = llm.with_structured_output(QuizGenerateResult)

        last_err: Exception | None = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                result: QuizGenerateResult = await structured_llm.ainvoke(
                    [
                        {"role": "system", "content": QUIZ_GEN_SYS_PROMPT},
                        {"role": "user", "content": f"出题方向：{prompt}\n难度：{difficulty}"},
                    ]
                )
                limit = int(result.answer_time_limit_seconds)
                if limit <= 0:
                    limit = _DIFFICULTY_LIMITS.get(result.difficulty, 1200)
                logger.info(
                    "[INTERNAL_QUIZ] generated task_id={} type={} difficulty={} (attempt={})",
                    task_id, result.question_type, result.difficulty, attempt,
                )
                await _quiz_coll().update_one(
                    {"task_id": task_id},
                    {"$set": {
                        "status": "ready",
                        "question": result.question,
                        "question_type": result.question_type,
                        "options": result.options,
                        "answer": result.answer,
                        "difficulty": result.difficulty,
                        "answer_time_limit_seconds": limit,
                        "generated_at": time.time(),
                    }},
                )
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
