"""
Per-page vectorization router — thin HTTP layer over VectorPageService.

Granularity: single page (bvid + cid).
For folder-level batch vectorization, use POST /knowledge/build.
"""

import asyncio
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.response.vector import (
    VectorPageStatusResponse, VectorPageTaskStatus,
    VectorPageCreateRequest, VectorPageReVectorRequest,
)
from app.routers.auth import get_current_uid, get_session_token
from app.services.auth import validate_token as _validate_token
from app.services.async_task.tracker import TaskTracker
from app.services.vector_page_service import VectorPageService

router = APIRouter(prefix="/vec/page", tags=["VectorPage"])

_tracker = TaskTracker()
_vector_service: Optional[VectorPageService] = None


def get_vector_service() -> VectorPageService:
    global _vector_service
    if _vector_service is None:
        _vector_service = VectorPageService(_tracker)
    return _vector_service


async def _resolve_optional_uid(
    token_str: Optional[str] = Depends(get_session_token),
    db: AsyncSession = Depends(get_db),
) -> int:
    """Resolve uid from token. Raises 401 if not authenticated."""
    if not token_str:
        raise HTTPException(status_code=401, detail="未登录")
    uid = await _validate_token(db, token_str)
    if uid is None:
        raise HTTPException(status_code=401, detail="token 无效或已过期")
    return uid


@router.get("/status", response_model=VectorPageStatusResponse)
async def get_vec_status(
    bvid: str,
    cid: int,
    db: AsyncSession = Depends(get_db),
    uid: int = Depends(get_current_uid),
) -> VectorPageStatusResponse:
    """Query per-page vectorization status with cross-store consistency check."""
    resp = await get_vector_service().get_status(bvid, cid, db)
    return VectorPageStatusResponse(**resp)


@router.post("/create")
async def create_vec(
    req: VectorPageCreateRequest,
    db: AsyncSession = Depends(get_db),
    uid: int = Depends(_resolve_optional_uid),
):
    """Idempotent vectorization — runs ASR first if needed, then vectors."""
    return await get_vector_service().create_task(
        bvid=req.bvid,
        cid=req.cid,
        page_index=req.page_index,
        page_title=req.page_title,
        uid=uid,
        db=db,
    )


@router.post("/revector")
async def revector_vec(
    req: VectorPageReVectorRequest,
    db: AsyncSession = Depends(get_db),
    uid: int = Depends(_resolve_optional_uid),
):
    """Force re-vectorization — deletes old vectors, creates new ones."""
    return await get_vector_service().revector(
        bvid=req.bvid, cid=req.cid, uid=uid, db=db
    )


@router.get("/status/{task_id}", response_model=VectorPageTaskStatus)
async def get_vec_task_status(
    task_id: str,
    uid: int = Depends(get_current_uid),
) -> VectorPageTaskStatus:
    """Poll task status with step-level progress."""
    resp = await get_vector_service().get_task_status(task_id, uid)
    return VectorPageTaskStatus(**resp)


# ══════════════════════════════════════════════════════════════════
# Internal — ASR completion triggers vectorization automatically
# ══════════════════════════════════════════════════════════════════

async def _trigger_asr_then_vec(
    asr_task_id: str,
    bvid: str,
    cid: int,
    page_index: int,
    page_title: str,
    uid: int = 0,
):
    """Chain: wait for ASR → then start vectorization."""
    from app.services.async_task.asr_task_registry import asr_tasks

    for _ in range(300):
        task = asr_tasks.get(asr_task_id)
        if task and task["status"] in ("done", "failed"):
            break
        await asyncio.sleep(1)

    task_id = await _tracker.create(
        uid=uid,
        task_type="vec_page",
        target={
            "bvid": bvid,
            "cid": cid,
            "page_index": page_index,
            "page_title": page_title,
        },
    )

    await asyncio.sleep(1)

    get_vector_service()._spawn_process_page_vectorization(
        task_id=task_id,
        bvid=bvid,
        cid=cid,
        page_index=page_index,
        page_title=page_title,
    )
