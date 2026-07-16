"""Notes router — CRUD, anchors, revisions, sharing.

All endpoints except ``GET /notes/shared/{token}`` require authentication
via ``get_current_uid``. Cross-user access returns 404 (not 403) to avoid
leaking note existence.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Header, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.response.notes import (
    NoteAnchorRequest,
    NoteAnchorResponse,
    NoteCreateRequest,
    NoteDetailResponse,
    NoteMetaResponse,
    NoteRevisionResponse,
    NoteShareCreateRequest,
    NoteShareResponse,
    NoteSharedView,
    NoteUpdateRequest,
)
from app.routers.auth import get_current_uid
from app.services.notes.service import (
    NoteConflictError,
    NoteNotFoundError,
    get_note_service,
)

router = APIRouter(prefix="/notes", tags=["notes"])


def _parse_if_match(if_match: Optional[str]) -> Optional[datetime]:
    """Parse the If-Match header (ISO-8601) into an aware datetime."""
    if not if_match:
        return None
    try:
        # Tolerate trailing 'Z' (UTC) — datetime.fromisoformat in 3.11+ handles it.
        return datetime.fromisoformat(if_match.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, "If-Match must be ISO-8601 datetime")


# ── Public sharing (declared BEFORE /{note_uuid} to win prefix match) ──


@router.get("/shared/{share_token}", response_model=NoteSharedView)
async def get_shared_note(
    share_token: str,
    db: AsyncSession = Depends(get_db),
):
    """Public read-only access — no auth required."""
    try:
        return await get_note_service().get_shared_view(db, share_token)
    except NoteNotFoundError:
        raise HTTPException(404, "分享不存在或已失效")


# ── CRUD ──────────────────────────────────────────────────────────


@router.get("", response_model=list[NoteMetaResponse])
async def list_notes(
    response: Response,
    target_type: Optional[str] = Query(None, pattern="^(video|cloud_file)$"),
    target_id: Optional[str] = Query(None, max_length=100),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    notes, total = await get_note_service().list_notes(
        db,
        uid,
        target_type=target_type,
        target_id=target_id,
        page=page,
        page_size=page_size,
    )
    response.headers["X-Total-Count"] = str(total)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count"
    return notes


@router.post("", response_model=NoteDetailResponse, status_code=201)
async def create_note(
    req: NoteCreateRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    try:
        meta = await get_note_service().create_note(
            db,
            uid=uid,
            title=req.title,
            target_type=req.target_type,
            target_id=req.target_id,
            content_md=req.content_md,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return await _fetch_detail(db, meta["uuid"], uid)


@router.get("/{note_uuid}", response_model=NoteDetailResponse)
async def get_note(
    note_uuid: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    return await _fetch_detail(db, note_uuid, uid)


@router.patch("/{note_uuid}", response_model=NoteDetailResponse)
async def update_note(
    note_uuid: str,
    req: NoteUpdateRequest,
    if_match: Optional[str] = Header(None, alias="If-Match"),
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    service = get_note_service()
    try:
        await service.update_note(
            db,
            note_uuid,
            uid=uid,
            title=req.title,
            content_md=req.content_md,
            is_pinned=req.is_pinned,
            if_match=_parse_if_match(if_match),
        )
    except NoteNotFoundError:
        raise HTTPException(404, "笔记不存在")
    except NoteConflictError as e:
        raise HTTPException(
            409,
            detail={
                "error": "conflict",
                "note_uuid": e.note_uuid,
                "server_updated_at": e.server_updated_at.isoformat(),
            },
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return await _fetch_detail(db, note_uuid, uid)


@router.delete("/{note_uuid}", status_code=204)
async def delete_note(
    note_uuid: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    try:
        await get_note_service().delete_note(db, note_uuid, uid=uid)
    except NoteNotFoundError:
        raise HTTPException(404, "笔记不存在")
    return None


async def _fetch_detail(db: AsyncSession, note_uuid: str, uid: int) -> dict:
    try:
        return await get_note_service().get_note(db, note_uuid, uid=uid)
    except NoteNotFoundError:
        raise HTTPException(404, "笔记不存在")


# ── Anchors ───────────────────────────────────────────────────────


@router.post(
    "/{note_uuid}/anchors",
    response_model=NoteAnchorResponse,
    status_code=201,
)
async def add_anchor(
    note_uuid: str,
    req: NoteAnchorRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await get_note_service().add_anchor(
            db,
            note_uuid,
            uid=uid,
            block_id=req.block_id,
            position=req.position,
            label=req.label,
        )
    except NoteNotFoundError:
        raise HTTPException(404, "笔记不存在")


@router.delete("/{note_uuid}/anchors/{anchor_id}", status_code=204)
async def delete_anchor(
    note_uuid: str,
    anchor_id: int,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    try:
        await get_note_service().delete_anchor(
            db, note_uuid, anchor_id, uid=uid
        )
    except NoteNotFoundError:
        raise HTTPException(404, "锚点不存在")
    return None


# ── Revisions ─────────────────────────────────────────────────────


@router.get(
    "/{note_uuid}/revisions",
    response_model=list[NoteRevisionResponse],
)
async def list_revisions(
    note_uuid: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await get_note_service().list_revisions(db, note_uuid, uid=uid)
    except NoteNotFoundError:
        raise HTTPException(404, "笔记不存在")


@router.post(
    "/{note_uuid}/revisions/restore/{revision_id}",
    response_model=NoteDetailResponse,
)
async def restore_revision(
    note_uuid: str,
    revision_id: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    try:
        await get_note_service().restore_revision(
            db, note_uuid, revision_id, uid=uid
        )
    except NoteNotFoundError:
        raise HTTPException(404, "笔记或修订不存在")
    return await _fetch_detail(db, note_uuid, uid)


# ── Sharing ───────────────────────────────────────────────────────


@router.post("/{note_uuid}/share", response_model=NoteShareResponse)
async def create_share(
    note_uuid: str,
    req: NoteShareCreateRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await get_note_service().create_share(
            db, note_uuid, uid=uid, expires_in_days=req.expires_in_days
        )
    except NoteNotFoundError:
        raise HTTPException(404, "笔记不存在")


@router.delete("/{note_uuid}/share", status_code=204)
async def revoke_share(
    note_uuid: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    try:
        await get_note_service().revoke_share(db, note_uuid, uid=uid)
    except NoteNotFoundError:
        raise HTTPException(404, "笔记不存在")
    return None
