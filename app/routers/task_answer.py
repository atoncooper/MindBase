"""用户答题提交端点：POST /tasks/{task_id}/answer（主 app 负责判题/入库）。

Auth: APISIX forward-auth 校验 bili_session 后注入 X-Uid，本端点信任 X-Uid。
APISIX 的 /tasks/*/answer 路由（priority 100）将请求转发到主 app，其余
/tasks/* 仍由 app-task 提供（列表/详情）。
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

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
