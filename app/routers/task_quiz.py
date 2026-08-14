"""task-quiz agent SSE endpoint: POST /task-quiz/chat.

Auth: APISIX forward-auth validates bili_session and injects X-Uid header.
This endpoint reads uid from X-Uid (trusts APISIX) and resolves user_email
via UserService. No bili_session validation here - APISIX already did it.
"""

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from loguru import logger

import os

import httpx
from pydantic import BaseModel, Field

from app.agent.task_quiz.graph import get_agent
from app.database import get_db_context
from app.routers.auth import _get_sf
from app.services.auth import UserService

router = APIRouter(prefix="/task-quiz", tags=["task-quiz"])


async def _resolve_email(uid: int) -> str:
    """Look up the user's email by uid (main app has user store).

    Uses get_full_profile (not get_user_by_uid) because the latter omits email
    from its returned dict by design, while get_full_profile includes it.
    """
    async with get_db_context() as db:
        user_service = UserService(db, await _get_sf())
        info = await user_service.get_full_profile(uid)
        return (info or {}).get("email", "") or ""


@router.post("/chat")
async def chat(request: Request):
    # APISIX forward-auth injected X-Uid after verifying bili_session
    uid_header = request.headers.get("X-Uid")
    if not uid_header:
        raise HTTPException(401, "unauthorized (X-Uid missing)")
    uid = int(uid_header)

    body = await request.json()
    message = body.get("message", "")
    user_email = await _resolve_email(uid)

    agent = get_agent()
    # Inject uid/email so the agent can pass them to submit_task
    user_input = f"[uid={uid} email={user_email}] {message}"

    async def stream():
        try:
            async for event in agent.astream_events(
                {"messages": [("user", user_input)]}, version="v2"
            ):
                kind = event["event"]
                if kind == "on_chat_model_stream":
                    chunk = event["data"]["chunk"].content
                    if chunk:
                        yield f"data: {json.dumps({'type': 'chunk', 'content': chunk})}\n\n"
                elif kind == "on_tool_start":
                    yield f"data: {json.dumps({'type': 'tool', 'name': event['name'], 'status': 'start'})}\n\n"
                elif kind == "on_tool_end":
                    out = str(event["data"].get("output", ""))[:200]
                    yield f"data: {json.dumps({'type': 'tool', 'name': event['name'], 'status': 'end', 'output': out})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except Exception as e:
            logger.exception("[TASK_QUIZ] stream error")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


class TaskRegisterRequest(BaseModel):
    """User-facing task registration form (APISIX forward-auth injects X-Uid)."""
    prompt: str = Field(..., max_length=500)
    difficulty: str = Field("medium", pattern="^(easy|medium|hard)$")  # 考研难度：简单/中等/压轴
    question_count: int = Field(1, ge=1, le=5)  # 本次任务出题数量（1~5）
    trigger_time: str  # ISO8601 UTC
    cc_emails: list[str] = Field(default_factory=list)
    incomplete_message: str | None = None


@router.post("/register")
async def register(request: Request, req: TaskRegisterRequest):
    """Register a scheduled quiz task. User-facing (X-Uid from APISIX forward-auth).
    Forwards to app-task /tasks/register (service-to-service key-auth via APISIX)."""
    uid_header = request.headers.get("X-Uid")
    if not uid_header:
        raise HTTPException(401, "unauthorized (X-Uid missing)")
    uid = int(uid_header)
    user_email = await _resolve_email(uid)
    if not user_email:
        raise HTTPException(400, "user email not found; set email in profile first")

    # trigger_time must be in the future (tolerate 1min clock skew)
    try:
        trigger = datetime.fromisoformat(req.trigger_time.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, "invalid trigger_time (expect ISO8601)")
    if trigger < datetime.now(timezone.utc) - timedelta(minutes=1):
        raise HTTPException(400, "触发时间必须晚于当前时间")

    base = os.environ.get("APPTASK_BASE_URL", "http://apisix:9080").rstrip("/")
    key = os.environ.get("APISIX_CONSUMER_KEY", "")
    payload = {
        "uid": uid,
        "user_email": user_email,
        "cc_emails": req.cc_emails,
        "prompt": req.prompt,
        "difficulty": req.difficulty,
        "question_count": req.question_count,
        "trigger_time": req.trigger_time,
        "incomplete_message": req.incomplete_message,
    }
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{base}/tasks/register",
                json=payload,
                headers={"apikey": key, "Content-Type": "application/json"},
            )
    except Exception as e:
        logger.exception("[TASK_QUIZ] register forward failed")
        raise HTTPException(502, f"app-task unreachable: {e}")
    if resp.status_code != 200:
        raise HTTPException(502, f"app-task register failed: {resp.text[:200]}")
    return resp.json()
