"""
Per-page vectorization router — 4 API endpoints.

Granularity: single page (bvid + cid).
For folder-level batch vectorization, use POST /knowledge/build.
"""

import asyncio
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Video
from app.response.vector import (
    VectorPageStatusResponse, VectorPageTaskStatus,
    VectorPageCreateRequest, VectorPageReVectorRequest,
)
from app.routers.auth import get_current_uid, get_session_token
from app.services.auth import validate_token as _validate_token
from app.services.async_task.tracker import TaskTracker
from app.services.vector_page_service import VectorPageService
from app.services.rag import get_rag_service

router = APIRouter(prefix="/vec/page", tags=["VectorPage"])

# Global singletons
_tracker = TaskTracker()
_vector_service: Optional[VectorPageService] = None


def get_vector_service() -> VectorPageService:
    global _vector_service
    if _vector_service is None:
        _vector_service = VectorPageService(_tracker)
    return _vector_service


# ══════════════════════════════════════════════════════════════════
# API endpoints
# ══════════════════════════════════════════════════════════════════

@router.get("/status")
async def get_vec_status(
    bvid: str,
    cid: int,
    db: AsyncSession = Depends(get_db)
) -> VectorPageStatusResponse:
    """Query per-page vectorization status with ChromaDB consistency check."""
    result = await db.execute(
        select(Video).where(Video.bvid == bvid, Video.cid == cid)
    )
    page = result.scalar_one_or_none()

    if not page:
        return VectorPageStatusResponse(
            exists=False,
            is_processed=False,
            is_vectorized="pending",
            vector_chunk_count=0,
            chroma_exists=False,
        )

    from app.infra.config import config as _cfg
    rag = get_rag_service()
    actual_count = rag.get_page_vector_count(bvid, page.page_index)

    vector_exists = actual_count > 0
    fixed_vectorized = page.is_vectorized

    if page.is_vectorized == "done" and actual_count == 0:
        backend_name = "Milvus" if _cfg.milvus.enabled else "ChromaDB"
        page.is_vectorized = "failed"
        page.vector_error = f"{backend_name} vector count is 0 — data may be corrupted"
        await db.commit()
        fixed_vectorized = "failed"
        vector_exists = False

    elif page.is_vectorized == "pending" and actual_count > 0:
        page.is_vectorized = "done"
        from datetime import datetime
        page.vectorized_at = datetime.utcnow()
        page.vector_chunk_count = actual_count
        await db.commit()
        fixed_vectorized = "done"
        vector_exists = True

    return VectorPageStatusResponse(
        exists=True,
        bvid=page.bvid,
        cid=page.cid,
        page_index=page.page_index,
        page_title=page.page_title,
        is_processed=page.is_processed,
        content_preview=None,
        is_vectorized=fixed_vectorized,
        vectorized_at=page.vectorized_at,
        vector_chunk_count=page.vector_chunk_count or actual_count,
        vector_error=page.vector_error,
        chroma_exists=vector_exists,
        steps=None,
    )


async def _resolve_optional_uid(
    token_str: Optional[str] = Depends(get_session_token),
    db: AsyncSession = Depends(get_db),
) -> int:
    """Resolve uid from token. Raises 401 if not authenticated (mandatory for create)."""
    if not token_str:
        raise HTTPException(status_code=401, detail="未登录")
    uid = await _validate_token(db, token_str)
    if uid is None:
        raise HTTPException(status_code=401, detail="token 无效或已过期")
    return uid


@router.post("/create")
async def create_vec(
    req: VectorPageCreateRequest,
    db: AsyncSession = Depends(get_db),
    uid: int = Depends(_resolve_optional_uid),
):
    """Idempotent vectorization — runs ASR first if needed, then vectors."""
    result = await db.execute(
        select(Video).where(Video.bvid == req.bvid, Video.cid == req.cid)
    )
    page = result.scalar_one_or_none()

    if not page:
        page = Video(
            bvid=req.bvid,
            cid=req.cid,
            page_index=req.page_index,
            page_title=req.page_title or f"P{req.page_index + 1}",
            is_processed=False,
            version=1,
            is_vectorized="pending",
            vector_chunk_count=0,
        )
        db.add(page)
        await db.commit()
        await db.refresh(page)

    if page.is_vectorized == "done":
        return {"task_id": None, "message": "Already up to date"}

    task_id = await _tracker.create(
        uid=uid,
        task_type="vec_page",
        target={
            "bvid": req.bvid,
            "cid": req.cid,
            "page_index": req.page_index,
            "page_title": req.page_title or page.page_title,
        },
    )

    asyncio.create_task(
        get_vector_service().process_page_vectorization(
            task_id=task_id,
            bvid=req.bvid,
            cid=req.cid,
            page_index=req.page_index,
            page_title=req.page_title or page.page_title or f"P{req.page_index + 1}",
        )
    )

    return {"task_id": task_id, "message": "Vectorization task created"}


@router.post("/revector")
async def revector_vec(
    req: VectorPageReVectorRequest,
    db: AsyncSession = Depends(get_db),
    uid: int = Depends(_resolve_optional_uid),
):
    """Force re-vectorization — deletes old vectors, creates new ones."""
    result = await db.execute(
        select(Video).where(Video.bvid == req.bvid, Video.cid == req.cid)
    )
    page = result.scalar_one_or_none()

    if not page:
        raise HTTPException(status_code=404, detail="Video page not found")

    if not page.is_processed:
        raise HTTPException(status_code=400, detail="ASR not completed — cannot vectorize")

    page.is_vectorized = "pending"
    page.vector_error = None
    await db.commit()

    task_id = await _tracker.create(
        uid=uid,
        task_type="vec_page",
        target={
            "bvid": req.bvid,
            "cid": req.cid,
            "page_index": page.page_index,
            "page_title": page.page_title,
        },
    )

    asyncio.create_task(
        get_vector_service().process_page_vectorization(
            task_id=task_id,
            bvid=req.bvid,
            cid=req.cid,
            page_index=page.page_index,
            page_title=page.page_title or f"P{page.page_index + 1}",
        )
    )

    return {"task_id": task_id, "message": "Re-vectorization task created"}


@router.get("/status/{task_id}")
async def get_vec_task_status(task_id: str) -> VectorPageTaskStatus:
    """Poll task status with step-level progress."""
    from app.database import get_db_context
    async with get_db_context() as db:
        task = await _tracker._repo.get_by_task_id(task_id, db)

    if not task:
        from app.routers.asr import asr_tasks
        asr_task = asr_tasks.get(task_id)
        if asr_task:
            return VectorPageTaskStatus(
                task_id=task_id,
                status=asr_task["status"],
                progress=asr_task["progress"],
                message=asr_task["message"],
                steps=[{"name": "asr", "status": asr_task["status"], "progress": asr_task["progress"]}],
            )
        raise HTTPException(status_code=404, detail="Task not found")

    status = task.status
    if status == "done":
        message = "Complete"
    elif status == "failed":
        message = f"Failed: {task.error or 'unknown'}"
    elif status == "processing":
        message = "Processing..."
    else:
        message = "Pending"

    return VectorPageTaskStatus(
        task_id=task.task_id,
        status=status,
        progress=task.progress or 0,
        message=message,
        steps=task.steps,
        result=task.result,
        error=task.error,
    )


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
    from app.routers.asr import asr_tasks

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

    asyncio.create_task(
        get_vector_service().process_page_vectorization(
            task_id=task_id,
            bvid=bvid,
            cid=cid,
            page_index=page_index,
            page_title=page_title,
        )
    )
