"""Internal endpoint: ASYNC pure-LLM quiz generation (NO RAG).

Router only does param parsing + delegates to QuizGenService. Business logic
(LLM call, idempotency, Mongo storage, background task) lives in
app/services/quiz_gen/service.py.

Called by app-task via APISIX (key-auth). ASYNC model: POST /generate-llm
returns immediately with {status: generating|ready}; app-task polls
GET /status/{task_id} until ready/failed.
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.services.quiz_gen.service import QuizGenService
from app.services.quiz_task_service import create_quiz_task

router = APIRouter(prefix="/internal/quiz", tags=["internal-quiz"])


class QuizGenerateRequest(BaseModel):
    prompt: str  # 出题方向（粗粒度，如"数学1填空题"）
    uid: int | None = None
    difficulty: str = "medium"  # easy/medium/hard
    question_count: int = 1  # 本次任务出题数量（1~5）
    # 可选：app-task 的 HTTP executor 把 task_id 放在 X-Task-Id 头里透传，
    # body 里通常没有该字段。设为可空 + 默认空串，让 handler 的头部兜底生效
    # （否则 Pydantic 校验会先 422，兜底逻辑永远到不了）。
    task_id: str = ""
    user_email: str = ""  # 题目邮件收件人
    cc_emails: list[str] = []  # 抄送
    incomplete_message: str | None = None  # 未完成语录（超时邮件用）


@router.post("/generate-llm")
async def generate_llm(request: Request, req: QuizGenerateRequest):
    """Async + idempotent quiz generation (executor side).

    app-task triggers this task; X-Task-Id = task_id (business correlation). We
    create the business row, launch background generation, and return 202
    (accepted) so app-task marks the task running. When generation completes,
    the service sends the quiz email via app-task and reports task completion.
    """
    task_id = req.task_id or request.headers.get("X-Task-Id", "")
    if not task_id:
        raise HTTPException(400, "X-Task-Id required")
    try:
        await create_quiz_task(
            task_id=task_id,
            uid=req.uid or 0,
            prompt=req.prompt,
            difficulty=req.difficulty,
            question_count=req.question_count,
            user_email=req.user_email,
            cc_emails=req.cc_emails or [],
            incomplete_message=req.incomplete_message,
        )
        resp = await QuizGenService.generate(
            task_id, req.prompt, req.difficulty, req.uid, req.question_count,
            user_email=req.user_email, cc_emails=req.cc_emails or [],
            incomplete_message=req.incomplete_message,
        )
        return resp, 202  # accepted → app-task marks the task running
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@router.get("/status/{task_id}")
async def quiz_status(task_id: str):
    """Poll quiz generation status. app-task calls this until ready/failed."""
    return await QuizGenService.get_status(task_id)
