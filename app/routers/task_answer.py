"""用户答题提交端点：POST /tasks/{task_id}/answer（主 app 负责判题/入库）。

Auth: APISIX forward-auth 校验 bili_session 后注入 X-Uid，本端点信任 X-Uid。
APISIX 的 /tasks/*/answer 路由（priority 100）将请求转发到主 app，其余
/tasks/* 仍由 app-task 提供（列表/详情）。
"""

from fastapi import APIRouter, HTTPException, Request
import json
from pydantic import BaseModel, Field

from app.services.quiz_gen.service import QuizGenService
from app.services.quiz_task_service import get_answers, get_quiz_task_by_uid
from app.services.task_quiz_answer import (
    TaskQuizForbidden,
    TaskQuizNotFound,
    submit_task_quiz_answer,
)

router = APIRouter(prefix="/tasks", tags=["task-quiz"])


class TaskAnswerItem(BaseModel):
    question_index: int = 0
    answer: str = Field(..., min_length=1, max_length=2000)


class TaskAnswerRequest(BaseModel):
    """多题答题：answers 数组；answer 为单题旧格式（兼容，等价于 question_index=0）。"""

    answers: list[TaskAnswerItem] | None = None
    answer: str | None = Field(None, max_length=2000)


@router.post("/{task_id}/answer")
async def submit_answer(request: Request, task_id: str, req: TaskAnswerRequest):
    """提交答案：逐题判题 + 入库 + 状态流转（sent -> completed）。"""
    uid_header = request.headers.get("X-Uid")
    if not uid_header:
        raise HTTPException(401, "unauthorized (X-Uid missing)")
    try:
        uid = int(uid_header)
    except ValueError:
        raise HTTPException(401, "invalid X-Uid")

    if req.answers:
        answers = [
            {"question_index": a.question_index, "answer": a.answer}
            for a in req.answers
        ]
    elif req.answer is not None:
        answers = [{"question_index": 0, "answer": req.answer}]
    else:
        raise HTTPException(400, "answer or answers required")

    try:
        return await submit_task_quiz_answer(task_id, uid, answers)
    except TaskQuizNotFound:
        raise HTTPException(404, "task not found")
    except TaskQuizForbidden:
        raise HTTPException(403, "not the task owner")


@router.get("/{task_id}/detail")
async def task_detail(request: Request, task_id: str):
    """业务详情（题目 + 答案 + 业务状态）。uid 由 APISIX X-Uid 注入。"""
    uid_header = request.headers.get("X-Uid")
    if not uid_header:
        raise HTTPException(401, "unauthorized (X-Uid missing)")
    try:
        uid = int(uid_header)
    except ValueError:
        raise HTTPException(401, "invalid X-Uid")

    task = await get_quiz_task_by_uid(task_id, uid)
    if task is None:
        raise HTTPException(404, "task not found")

    # 题目（主 app Mongo，task_id=task_id）
    quiz = await QuizGenService.get_status(task_id)
    quiz_questions = quiz.get("quiz", {}).get("questions", []) if quiz.get("quiz") else []
    answers = await get_answers(task_id)

    return {
        "task_id": task["task_id"],
        "prompt": task["prompt"],
        "difficulty": task["difficulty"],
        "status": task["status"],
        "deadline": task["deadline"].isoformat() if task.get("deadline") else None,
        # cc_emails 是 JSON 列，raw SQL 读出的是 JSON 字符串，需反序列化成数组
        "cc_emails": json.loads(task.get("cc_emails") or "[]"),
        "quiz": {"questions": quiz_questions},
        "answers": answers,
    }
