"""Admin endpoints for code execution records.

List / inspect / delete ``run_code`` executions across all users. All
endpoints require the ``admin`` RBAC role via ``require_admin``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.routers.auth import require_admin
from app.response.code_execution import (
    CodeExecutionListItem,
    CodeExecutionListResponse,
    CodeExecutionResponse,
)
from app.services import code_execution_service as service

router = APIRouter(prefix="/admin/code-executions", tags=["admin-code-executions"])


def _strip_mongo_id(row: dict) -> dict:
    return {k: v for k, v in row.items() if k != "_id"}


@router.get("", response_model=CodeExecutionListResponse)
async def list_code_executions(
    _uid: int = Depends(require_admin),
    uid: Optional[int] = Query(None, description="按用户筛选"),
    chat_session_id: Optional[str] = Query(None, description="按会话筛选"),
    assistant_msg_id: Optional[str] = Query(None, description="按消息筛选"),
    since: Optional[datetime] = Query(None, description="起始时间 (ISO 8601)"),
    until: Optional[datetime] = Query(None, description="结束时间 (ISO 8601)"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
) -> CodeExecutionListResponse:
    """Admin listing of code executions with optional filters."""
    rows, total = await service.list_for_admin(
        uid=uid,
        chat_session_id=chat_session_id,
        assistant_msg_id=assistant_msg_id,
        since=since,
        until=until,
        page=page,
        page_size=page_size,
    )
    return CodeExecutionListResponse(
        items=[CodeExecutionListItem(**_strip_mongo_id(r)) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/{exec_id}", response_model=CodeExecutionResponse)
async def get_code_execution(
    exec_id: str,
    _uid: int = Depends(require_admin),
) -> CodeExecutionResponse:
    """Full detail of one execution (admin scope, no ownership check)."""
    record = await service.get_for_admin(exec_id)
    if record is None:
        raise HTTPException(status_code=404, detail="代码执行记录不存在")
    return CodeExecutionResponse(**_strip_mongo_id(record))


@router.delete("/{exec_id}")
async def delete_code_execution(
    exec_id: str,
    _uid: int = Depends(require_admin),
) -> dict:
    """Delete a record and its MinIO artifacts (admin-only)."""
    deleted = await service.delete_for_admin(exec_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="代码执行记录不存在")
    return {"deleted": deleted, "exec_id": exec_id}
