"""
Pydantic response models for video metadata (arc_meta).
"""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class VideoMetadataResponse(BaseModel):
    """Structured metadata for a video page."""
    id: int
    video_id: int

    # AI-extracted
    summary: Optional[str] = None
    keywords: Optional[list[str]] = None
    topics: Optional[list[dict]] = None
    difficulty: Optional[str] = None

    # Content stats
    word_count: int = 0
    reading_time: int = 0
    language: Optional[str] = None

    # Video features
    has_code: bool = False
    has_math: bool = False
    is_tutorial: bool = False

    # User-editable
    user_tags: Optional[list[str]] = None
    notes: Optional[str] = None

    extracted_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class MetadataExtractResponse(BaseModel):
    """Result of triggering metadata extraction."""
    video_id: int
    message: str
    metadata: Optional[VideoMetadataResponse] = None


class MetadataUpdateRequest(BaseModel):
    """PATCH body for user-editable fields."""
    user_tags: Optional[list[str]] = None
    notes: Optional[str] = None
