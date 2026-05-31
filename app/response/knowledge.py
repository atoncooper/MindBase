"""
Pydantic schemas for knowledge API — request / response models.
"""

from enum import Enum
from typing import Optional
from pydantic import BaseModel


class ContentSource(str, Enum):
    """Content origin type."""
    AI_SUMMARY = "ai_summary"
    SUBTITLE = "subtitle"
    BASIC_INFO = "basic_info"
    ASR = "asr"


class VideoInfo(BaseModel):
    """Video info."""
    bvid: str
    cid: Optional[int] = None
    title: str
    description: Optional[str] = None
    owner_name: Optional[str] = None
    owner_mid: Optional[int] = None
    duration: Optional[int] = None
    pic_url: Optional[str] = None


class VideoContent(BaseModel):
    """Video content with analysis metadata."""
    bvid: str
    title: str
    content: str
    source: ContentSource
    outline: Optional[list] = None


class FavoriteFolderInfo(BaseModel):
    """Favorite folder info (legacy favorites router)."""
    media_id: int
    title: str
    media_count: int
    is_selected: bool = True
    is_default: Optional[bool] = None


class VideoPageInfo(BaseModel):
    """Single page (episode) info for a video."""
    cid: int
    page: int          # 1-based
    title: str         # B站 part field
    duration: int


class VideosResponse(BaseModel):
    """GET /knowledge/video/{bvid}/pages response (deprecated)."""
    bvid: str
    title: str
    pages: list[VideoPageInfo]
    page_count: int
