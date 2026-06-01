"""
Pydantic response models for favorites v2 API.

Differs from models.FavoriteFolderInfo:
  - Includes id (DB primary key) so the frontend can issue mutations
    (delete / update selected state) without additional lookups.
  - Includes last_sync_at (sync timestamp) for freshness display.
  - Video responses are fully modeled rather than returning bare dicts.
"""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class FavoriteFolderResponse(BaseModel):
    """v2 favorite folder (list item)."""
    id: int
    media_id: int
    title: str
    media_count: int
    is_default: bool = False
    is_selected: bool = True
    last_sync_at: Optional[datetime] = None


class FavoriteFolderListResponse(BaseModel):
    """Folder list envelope."""
    folders: list[FavoriteFolderResponse]
    total: int


class SyncFoldersResponse(BaseModel):
    """Result of syncing folders from Bilibili."""
    folders: list[FavoriteFolderResponse]
    total: int


class UpdateSelectedResponse(BaseModel):
    """Result of toggling folder selection."""
    folder_id: int
    is_selected: bool


class DeleteFolderResponse(BaseModel):
    """Result of soft-deleting a folder."""
    message: str
    folder_id: int


class FavoriteVideoResponse(BaseModel):
    """v2 favorite video (from collection)."""
    id: int
    bvid: str
    title: str
    cover: Optional[str] = None
    duration: Optional[int] = None
    owner: Optional[str] = None
    cid: Optional[int] = None
    is_selected: bool = True
    synced_at: Optional[str] = None


class FavoriteVideoListResponse(BaseModel):
    """Video list envelope for a folder."""
    folder_id: int
    total: int
    videos: list[FavoriteVideoResponse]


class SyncVideosResponse(BaseModel):
    """Result of syncing videos from Bilibili into a folder."""
    folder_id: int
    total: int
    added: int


class FavoriteVideoPageResponse(BaseModel):
    """Paginated video list for a folder (by media_id lookup)."""
    folder_id: int
    media_id: int
    folder_title: str
    videos: list[FavoriteVideoResponse]
    total: int
    page: int
    page_size: int
    has_more: bool


class VideoPageItem(BaseModel):
    """Single page (cid) of a video."""
    cid: int
    page_index: int
    page_title: Optional[str] = None
    is_processed: bool = False
    is_vectorized: str = "pending"
    vector_chunk_count: int = 0


class VideoPageListResponse(BaseModel):
    """All pages for a bvid."""
    bvid: str
    pages: list[VideoPageItem]
    page_count: int
    is_stored: bool = True
