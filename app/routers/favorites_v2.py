"""
Favorites v2 router — uid-based favorites management.

Upgrade over routers/favorites.py:
  - Auth: get_current_uid (token-based) instead of session_id query param
  - DB:   favorites data persisted via FavoriteService (uid-scoped)
  - Bilibili: cookies resolved directly from user_oauth by uid

Old endpoints under /favorites/* are preserved and unchanged.
"""

from fastapi import APIRouter, HTTPException, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from loguru import logger

from app.database import get_db
from app.models import UserOAuth
from app.routers.auth import get_current_uid
from app.infra.cache import cache_manager

_FAV_TTL = 300   # 5 minutes for folder/video lists
from app.services.auth.security import decrypt as _decrypt
from app.services.bilibili import BilibiliService
from app.services.favorite import FavoriteService
from app.response.favorites import (
    FavoriteFolderResponse,
    FavoriteVideoPageResponse,
    SyncFoldersResponse,
    UpdateSelectedResponse,
    DeleteFolderResponse,
    VideoPageListResponse,
)
from app.response.metadata import (
    VideoMetadataResponse,
    MetadataExtractResponse,
    MetadataUpdateRequest,
)

router = APIRouter(prefix="/favorites/v2", tags=["收藏夹 v2"])


def _get_favorite_service() -> FavoriteService:
    from app.main import app
    svc = getattr(app.state, "favorite_service", None)
    if svc is None:
        app.state.favorite_service = FavoriteService()
    return app.state.favorite_service


async def _resolve_bili_credentials(
    uid: int, db: AsyncSession
) -> tuple[BilibiliService, int]:
    """Look up Bilibili cookies by uid from user_oauth (with cache)."""
    ns = _oauth_cache_ns()

    async def _fetch():
        oauth_result = await db.execute(
            select(UserOAuth).where(
                UserOAuth.uid == uid,
                UserOAuth.provider == "bilibili",
            )
        )
        oauth = oauth_result.scalar_one_or_none()
        if not oauth or not oauth.access_token:
            return None
        sessdata = _decrypt(oauth.access_token)
        if not sessdata:
            return None
        bili_mid = int(oauth.provider_uid) if oauth.provider_uid.isdigit() else 0
        return (sessdata, bili_mid)

    cached = await ns.get_or_fetch(str(uid), _fetch)
    if cached is None:
        raise HTTPException(status_code=401, detail="Bilibili account not linked")

    sessdata, bili_mid = cached
    return BilibiliService(sessdata=sessdata, bili_jct="", dedeuserid=str(bili_mid)), bili_mid


# ── Cache helpers ──────────────────────────────────────────────

def _fav_folder_ns():
    return cache_manager.namespace("fav_folder", ttl=_FAV_TTL)

def _fav_video_ns():
    return cache_manager.namespace("fav_video", ttl=_FAV_TTL)

def _oauth_cache_ns():
    return cache_manager.namespace("oauth_cookie", ttl=600)  # 10 min

async def _invalidate_folder_cache(uid: int) -> None:
    await _fav_folder_ns().delete(str(uid))


def _folder_to_response(f) -> FavoriteFolderResponse:
    return FavoriteFolderResponse(
        id=f.id,
        media_id=f.media_id,
        title=f.title,
        media_count=f.media_count,
        is_default=f.is_default or False,
        is_selected=f.is_selected,
        last_sync_at=f.last_sync_at,
    )


# ══════════════════════════════════════════════════════════════════
# Folders
# ══════════════════════════════════════════════════════════════════

@router.get("/list", response_model=list[FavoriteFolderResponse])
async def list_folders(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """List the current user's favorite folders.

    Reads from cache first → DB → auto-sync Bilibili if empty.
    Single-flight: concurrent requests coalesce to one DB query.
    """
    ns = _fav_folder_ns()

    async def _fetch():
        svc = _get_favorite_service()
        folders = await svc.list_folders(uid, db)
        if not folders:
            bili, bili_mid = await _resolve_bili_credentials(uid, db)
            try:
                folders = await svc.sync_folders(uid, bili, bili_mid, db)
            finally:
                await bili.close()
        return folders

    folders = await ns.get_or_fetch(str(uid), _fetch)
    return [_folder_to_response(f) for f in (folders or [])]


@router.post("/sync", response_model=SyncFoldersResponse)
async def sync_folders(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Sync all favorite folders from Bilibili into local DB (full refresh)."""
    svc = _get_favorite_service()
    bili, bili_mid = await _resolve_bili_credentials(uid, db)

    try:
        folders = await svc.sync_folders(uid, bili, bili_mid, db)
        await _invalidate_folder_cache(uid)
        return SyncFoldersResponse(
            folders=[_folder_to_response(f) for f in folders],
            total=len(folders),
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[FavoritesV2] sync folders failed")
        raise HTTPException(status_code=500, detail=f"Failed to sync folders: {str(e) or 'unknown error'}")
    finally:
        await bili.close()


@router.patch("/{folder_id}/selected", response_model=UpdateSelectedResponse)
async def update_folder_selected(
    folder_id: int,
    is_selected: bool = Query(..., description="Whether this folder is selected for the knowledge base"),
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Toggle a folder's selected state."""
    svc = _get_favorite_service()
    await svc.update_folder_selected(folder_id, is_selected, db)
    await _invalidate_folder_cache(uid)
    return UpdateSelectedResponse(folder_id=folder_id, is_selected=is_selected)


@router.delete("/{folder_id}", response_model=DeleteFolderResponse)
async def delete_folder(
    folder_id: int,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Soft-delete a folder (local-only, does not touch Bilibili data)."""
    svc = _get_favorite_service()
    ok = await svc.delete_folder(folder_id, db)
    if not ok:
        raise HTTPException(status_code=404, detail="Folder not found or already deleted")
    await _invalidate_folder_cache(uid)
    return DeleteFolderResponse(message="Deleted", folder_id=folder_id)


# ══════════════════════════════════════════════════════════════════
# Videos (by media_id — paginated, auto-sync)
# ══════════════════════════════════════════════════════════════════

@router.get("/media/{media_id}/videos", response_model=FavoriteVideoPageResponse)
async def list_videos_by_media_id(
    media_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=20),
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """List videos in a folder by Bilibili media_id with pagination.

    Reads from DB first. If no videos cached, auto-syncs from Bilibili
    (metadata → video_cache, links → favorite_videos), then returns
    the paginated result.
    """
    svc = _get_favorite_service()
    bili, _ = await _resolve_bili_credentials(uid, db)

    try:
        ns = _fav_video_ns()
        cache_key = f"{uid}:{media_id}:{page}:{page_size}"

        async def _fetch_videos():
            return await svc.list_videos_by_media_id(
                uid=uid,
                media_id=media_id,
                bili=bili,
                page=page,
                page_size=page_size,
                db=db,
            )

        result = await ns.get_or_fetch(cache_key, _fetch_videos)
        return FavoriteVideoPageResponse(**result)
    except ValueError as e:
        msg = str(e)
        status = 404
        raise HTTPException(status_code=status, detail=msg)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[FavoritesV2] list videos by media_id failed")
        raise HTTPException(status_code=500, detail=f"Failed to list videos: {str(e) or 'unknown error'}")
    finally:
        await bili.close()


# ══════════════════════════════════════════════════════════════════
# Video pages (bvid → cids)
# ══════════════════════════════════════════════════════════════════

@router.get("/video/{bvid}/pages", response_model=VideoPageListResponse)
async def list_video_pages(
    bvid: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """List all pages (cids) for a bvid.

    Reads from video table first. If empty, fetches from Bilibili API,
    persists to DB, and returns.
    """
    from app.services.video import VideoService

    svc = VideoService()
    bili, _ = await _resolve_bili_credentials(uid, db)

    try:
        result = await svc.list_pages_by_bvid(bvid, bili, db)
        return VideoPageListResponse(**result)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"[FavoritesV2] list video pages failed bvid={bvid}")
        raise HTTPException(status_code=500, detail=f"Failed to list pages: {str(e) or 'unknown error'}")
    finally:
        await bili.close()


# ══════════════════════════════════════════════════════════════════
# Video metadata (arc_meta — AI-extracted structured insights)
# ══════════════════════════════════════════════════════════════════

@router.get("/video/{bvid}/metadata", response_model=VideoMetadataResponse)
async def get_video_metadata(
    bvid: str,
    cid: int,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Get structured metadata for a video page (bvid + cid)."""
    from sqlalchemy import select
    from app.models import Video as VideoModel
    from app.services.video.metadata_service import MetadataService

    result = await db.execute(
        select(VideoModel).where(VideoModel.bvid == bvid, VideoModel.cid == cid)
    )
    page = result.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=404, detail="Video page not found")

    svc = MetadataService()
    meta = await svc.get_metadata(page.id, db)
    if not meta:
        raise HTTPException(status_code=404, detail="Metadata not extracted yet")
    return meta


@router.post("/video/{bvid}/metadata/extract", response_model=MetadataExtractResponse)
async def extract_video_metadata(
    bvid: str,
    cid: int,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Extract structured metadata from ASR content using LLM."""
    from sqlalchemy import select
    from app.models import Video as VideoModel
    from app.services.video.metadata_service import MetadataService

    result = await db.execute(
        select(VideoModel).where(VideoModel.bvid == bvid, VideoModel.cid == cid)
    )
    page = result.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=404, detail="Video page not found")

    svc = MetadataService()
    try:
        meta = await svc.extract_metadata(page.id, db)
        from app.services.video.service import _invalidate_video_pages
        await _invalidate_video_pages(bvid)
        return MetadataExtractResponse(
            video_id=page.id,
            message="Metadata extracted successfully",
            metadata=VideoMetadataResponse.model_validate(meta),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"[FavoritesV2] metadata extraction failed bvid={bvid}")
        raise HTTPException(status_code=500, detail=f"Extraction failed: {str(e) or 'unknown error'}")


@router.patch("/video/{bvid}/metadata", response_model=VideoMetadataResponse)
async def update_video_metadata(
    bvid: str,
    cid: int,
    payload: MetadataUpdateRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Update user-editable metadata fields (user_tags, notes)."""
    from sqlalchemy import select
    from app.models import Video as VideoModel
    from app.services.video.metadata_service import MetadataService

    result = await db.execute(
        select(VideoModel).where(VideoModel.bvid == bvid, VideoModel.cid == cid)
    )
    page = result.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=404, detail="Video page not found")

    svc = MetadataService()
    meta = await svc.update_user_tags(
        video_id=page.id,
        user_tags=payload.user_tags,
        notes=payload.notes,
        db=db,
    )
    from app.services.video.service import _invalidate_video_pages
    await _invalidate_video_pages(bvid)
    if not meta:
        raise HTTPException(status_code=404, detail="Metadata not found — extract first")
    return meta
