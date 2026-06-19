"""
Per-page vectorization router — 4 API endpoints.

Granularity: single page (bvid + cid).
For folder-level batch vectorization, use POST /knowledge/build.
"""

import asyncio
from datetime import datetime, timezone
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
from app.routers.auth import get_session_token
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

async def _check_mongo_content(bvid: str, cid: int) -> tuple[bool, Optional[str]]:
    """Verify content exists in MongoDB. Returns (exists, preview)."""
    from app.infra.mongo import is_enabled as _mongo_ok
    if not _mongo_ok():
        return False, None
    from app.repository.mongo_asr_repository import get_latest
    doc = await get_latest(bvid, cid)
    if doc and doc.get("content") and len(doc["content"].strip()) >= 50:
        return True, doc["content"][:200]
    return False, None


def _vec_status_cache_key(bvid: str, cid: int) -> str:
    return f"vec:status:{bvid}:{cid}"


def _folder_status_cache_key(uid: int) -> str:
    return f"folder_status:{uid}"


async def _invalidate_vec_status(bvid: str, cid: int):
    """Invalidate cached vector status after change."""
    try:
        from app.infra.redis import client as _redis, k
        if _redis:
            await _redis.delete(k("vec_status", f"{bvid}:{cid}"))
            await _redis.delete(k("folder_status_cache", "*"))  # broad invalidation
    except Exception:
        pass


@router.get("/status")
async def get_vec_status(
    bvid: str,
    cid: int,
    db: AsyncSession = Depends(get_db)
) -> VectorPageStatusResponse:
    """Query per-page vectorization status with cross-store consistency check."""
    # 1. Try Redis cache (30s TTL)
    try:
        from app.infra.redis import client as _redis, k, jget
        if _redis:
            cached = await jget(k("vec_status", f"{bvid}:{cid}"))
            if cached:
                return VectorPageStatusResponse(**cached)
    except Exception:
        pass

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
        )

    rag = get_rag_service()

    need_commit = False
    vector_exists = False
    content_exists = False
    content_preview = None

    # 2. Verify vector existence in vector DB
    actual_count = rag.get_page_vector_count(bvid, page.page_index)
    vector_exists = actual_count > 0

    if page.is_vectorized == "done" and actual_count == 0:
        page.is_vectorized = "failed"
        page.vector_error = "Milvus vector count is 0 — data lost after DB migration"
        need_commit = True
        vector_exists = False

    elif page.is_vectorized == "pending" and actual_count > 0:
        page.is_vectorized = "done"
        page.vectorized_at = datetime.now(timezone.utc)
        page.vector_chunk_count = actual_count
        need_commit = True
        vector_exists = True

    # 3. Verify content exists in MongoDB
    if page.is_processed:
        content_exists, content_preview = await _check_mongo_content(bvid, cid)
        if not content_exists:
            page.is_processed = False
            need_commit = True

    if need_commit:
        await db.commit()

    resp = VectorPageStatusResponse(
        exists=True,
        bvid=page.bvid,
        cid=page.cid,
        page_index=page.page_index,
        page_title=page.page_title,
        is_processed=page.is_processed,
        content_preview=content_preview,
        is_vectorized=page.is_vectorized if not (page.is_vectorized == "done" and not vector_exists) else "failed",
        vectorized_at=page.vectorized_at,
        vector_chunk_count=page.vector_chunk_count or actual_count,
        vector_error=page.vector_error,
        steps=None,
    )

    # 4. Cache result (30s TTL)
    try:
        from app.infra.redis import client as _redis2, k as _k2, jset as _jset
        if _redis2:
            await _jset(_k2("vec_status", f"{bvid}:{cid}"), resp.model_dump(), ex=30)
    except Exception:
        pass

    return resp


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
        from app.services.async_task.asr_task_registry import asr_tasks
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

    asyncio.create_task(
        get_vector_service().process_page_vectorization(
            task_id=task_id,
            bvid=bvid,
            cid=cid,
            page_index=page_index,
            page_title=page_title,
        )
    )
