"""User-facing endpoint for code execution records.

``GET /chat/messages/{msg_id}/code-executions`` returns the ``run_code``
calls the code agent made while producing the given assistant message.
Ownership is enforced at the repository layer; a foreign caller gets an
empty list (not 403) so message existence is not leaked.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.routers.auth import get_current_uid
from app.response.code_execution import (
    CodeExecutionListItem,
    CodeExecutionListResponse,
    CodeExecutionResponse,
)
from app.services import code_execution_service as service

router = APIRouter(prefix="/chat/messages", tags=["code-executions"])


def _strip_mongo_id(row: dict) -> dict:
    """Drop Mongo's ``_id`` so the dict validates against Pydantic models."""
    return {k: v for k, v in row.items() if k != "_id"}


@router.get(
    "/{msg_id}/code-executions",
    response_model=CodeExecutionListResponse,
)
async def list_message_code_executions(
    msg_id: str,
    uid: int = Depends(get_current_uid),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
) -> CodeExecutionListResponse:
    """List run_code executions associated with one assistant message."""
    rows, total = await service.list_for_user(
        msg_id, uid, page=page, page_size=page_size
    )
    return CodeExecutionListResponse(
        items=[CodeExecutionListItem(**_strip_mongo_id(r)) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get(
    "/{msg_id}/code-executions/{exec_id}",
    response_model=CodeExecutionResponse,
)
async def get_message_code_execution(
    msg_id: str,
    exec_id: str,
    uid: int = Depends(get_current_uid),
) -> CodeExecutionResponse:
    """Full detail of one execution belonging to ``msg_id``.

    Returns 404 if the record does not exist or belongs to another user
    (cross-user access is 404, not 403, to avoid leaking existence).
    """
    record = await service.get_for_user(exec_id, uid)
    if record is None or record.get("assistant_msg_id") != msg_id:
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="代码执行记录不存在")
    return CodeExecutionResponse(**_strip_mongo_id(record))
