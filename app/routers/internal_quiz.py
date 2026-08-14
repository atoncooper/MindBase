"""Internal endpoint: ASYNC pure-LLM quiz generation (NO RAG).

Router only does param parsing + delegates to QuizGenService. Business logic
(LLM call, idempotency, Mongo storage, background task) lives in
app/services/quiz_gen/service.py.

Called by app-task via APISIX (key-auth). ASYNC model: POST /generate-llm
returns immediately with {status: generating|ready}; app-task polls
GET /status/{task_id} until ready/failed.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.quiz_gen.service import QuizGenService

router = APIRouter(prefix="/internal/quiz", tags=["internal-quiz"])


class QuizGenerateRequest(BaseModel):
    prompt: str  # 出题方向（粗粒度，如"数学1填空题"）
    uid: int | None = None
    difficulty: str = "medium"  # easy/medium/hard（考研难度：简单/中等/压轴）
    question_count: int = 1  # 本次任务出题数量（1~5）
    task_id: str  # app-task passes this for idempotency + status polling


@router.post("/generate-llm")
async def generate_llm(req: QuizGenerateRequest):
    """Async + idempotent quiz generation. Returns generating/ready immediately."""
    try:
        return await QuizGenService.generate(
            req.task_id, req.prompt, req.difficulty, req.uid, req.question_count
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@router.get("/status/{task_id}")
async def quiz_status(task_id: str):
    """Poll quiz generation status. app-task calls this until ready/failed."""
    return await QuizGenService.get_status(task_id)
