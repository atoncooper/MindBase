"""Search-scope resolution for chat requests.

Given a `ChatRequest`, computes the (bvids, workspace_pages) pair that
the harness should pass to RAG.search.
"""

from typing import List, Optional

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Collection, FavoriteFolder
from app.response import ChatRequest


async def get_media_ids_for_uid(
    db: AsyncSession, uid: int, media_ids: Optional[List[int]]
) -> List[int]:
    """Resolve the synced favorite-folder media_id list for *uid*."""
    stmt = (
        select(FavoriteFolder.media_id)
        .where(FavoriteFolder.uid == uid, FavoriteFolder.deleted_at.is_(None))
        .order_by(FavoriteFolder.updated_at.desc())
    )
    if media_ids:
        stmt = stmt.where(FavoriteFolder.media_id.in_(media_ids))
    rows = await db.execute(stmt)
    seen: set[int] = set()
    result: list[int] = []
    for (mid,) in rows.fetchall():
        if mid and mid not in seen:
            seen.add(mid)
            result.append(mid)
    return result


async def get_bvids_by_media_ids(
    db: AsyncSession, media_ids: List[int]
) -> List[str]:
    """Resolve the BV-id list for the given favorite-folder media_ids."""
    if not media_ids:
        return []
    rows = await db.execute(
        select(Collection.bvid).where(Collection.media_id.in_(media_ids))
    )
    bvids: list[str] = []
    seen: set[str] = set()
    for (bvid,) in rows.fetchall():
        if not bvid or bvid in seen:
            continue
        seen.add(bvid)
        bvids.append(bvid)
    return bvids


async def resolve_search_scope(
    request: ChatRequest,
    db: AsyncSession,
    uid: Optional[int],
) -> tuple[Optional[list[str]], Optional[list[dict]]]:
    """Compute (bvids, workspace_pages) the harness should pass to RAG.search.

    Workspace_id expands to upload UUIDs; folder_ids resolve to bvids via
    the user's synced favorites. The harness planner owns all routing
    decisions, so this helper only computes scope filters. Returns
    ``(None, None)`` when no scope filter applies (full-vector search).
    """
    workspace_pages_dicts: Optional[list[dict]] = None
    if request.workspace_pages:
        workspace_pages_dicts = [wp.model_dump() for wp in request.workspace_pages]

    if request.workspace_id is not None:
        from app.infra.redis import redis_client
        from app.repository.workspace_repository import WorkspaceRepository

        ws_repo = WorkspaceRepository(redis=redis_client if redis_client else None)
        ws = await ws_repo.get_by_id(request.workspace_id, uid, db)
        if ws is None:
            raise HTTPException(status_code=404, detail="工作区不存在")
        ws_upload_uuids = list(
            await ws_repo.expand_bindings(request.workspace_id, uid, db)
        )
        return ws_upload_uuids or None, None

    if uid is not None:
        media_ids = await get_media_ids_for_uid(db, uid, request.folder_ids)
        bvids = await get_bvids_by_media_ids(db, media_ids) if media_ids else []
        return (bvids or None), workspace_pages_dicts

    return None, workspace_pages_dicts
