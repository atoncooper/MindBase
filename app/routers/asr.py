"""
ASR router — thin HTTP layer over ASRPageService.

Owns: parameter parsing, dependency injection, response marshalling.
Owns NOT: DB operations, background task spawning, MongoDB access.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.response import (
    ASRCreateRequest, ASRUpdateRequest, ASRReASRRequest,
    ASRContentResponse, ASRTaskStatus, VideoVersionInfo,
)
from app.routers.auth import get_current_uid
from app.services.asr_page_service import ASRPageService

router = APIRouter(prefix="/asr", tags=["ASR"])


def get_ASRPageService() -> ASRPageService:
    """DI factory for ASRPageService (kept lazy to avoid circular imports)."""
    return ASRPageService()


@router.get("/content", response_model=ASRContentResponse)
async def get_asr_content(
    bvid: str,
    cid: int,
    db: AsyncSession = Depends(get_db),
    uid: int = Depends(get_current_uid),
) -> ASRContentResponse:
    """Query ASR content — MongoDB first, MySQL fallback."""
    return await get_ASRPageService().get_content(bvid, cid, db)


@router.post("/create")
async def create_asr(
    req: ASRCreateRequest,
    db: AsyncSession = Depends(get_db),
    service: ASRPageService = Depends(get_ASRPageService),
    uid: int = Depends(get_current_uid),
):
    """Idempotent ASR task creation."""
    return await service.create_task(
        bvid=req.bvid,
        cid=req.cid,
        page_index=req.page_index,
        page_title=req.page_title,
        uid=uid,
        db=db,
    )


@router.post("/update")
async def update_asr_content(
    req: ASRUpdateRequest,
    db: AsyncSession = Depends(get_db),
    uid: int = Depends(get_current_uid),
):
    """Overwrite ASR content (user edit, no new version)."""
    await get_ASRPageService().update_content(
        bvid=req.bvid,
        page_index=req.page_index,
        content=req.content,
        db=db,
    )
    return {"success": True, "message": "更新成功"}


@router.post("/reasr")
async def reasr(
    req: ASRReASRRequest,
    db: AsyncSession = Depends(get_db),
    service: ASRPageService = Depends(get_ASRPageService),
    uid: int = Depends(get_current_uid),
):
    """Force re-ASR (creates a new version)."""
    return await service.reasr(
        bvid=req.bvid, page_index=req.page_index, uid=uid, db=db
    )


@router.get("/status/{task_id}", response_model=ASRTaskStatus)
async def get_task_status(
    task_id: str,
    uid: int = Depends(get_current_uid),
) -> ASRTaskStatus:
    """Poll task status."""
    return await get_ASRPageService().get_task_status(task_id, uid)


@router.get("/versions", response_model=list[VideoVersionInfo])
async def get_versions(
    bvid: str,
    cid: int,
    db: AsyncSession = Depends(get_db),
    uid: int = Depends(get_current_uid),
) -> list[VideoVersionInfo]:
    """Query version history — MongoDB first, MySQL fallback."""
    return await get_ASRPageService().list_versions(bvid, cid, db)
