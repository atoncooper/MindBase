"""Pydantic schemas for the notes API."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


# ── Notes ───────────────────────────────────────────────────────────


class NoteCreateRequest(BaseModel):
    title: str = Field(default="无标题", max_length=500)
    target_type: str = Field(..., pattern="^(video|cloud_file)$")
    target_id: str = Field(..., min_length=1, max_length=100)
    content_md: str = Field(default="", max_length=512 * 1024)  # 256 KB cap


class NoteUpdateRequest(BaseModel):
    title: Optional[str] = Field(default=None, max_length=500)
    content_md: Optional[str] = Field(default=None, max_length=512 * 1024)
    is_pinned: Optional[bool] = None


class NoteAnchorRequest(BaseModel):
    block_id: str = Field(..., min_length=1, max_length=50)
    position: int = Field(..., ge=0)
    label: Optional[str] = Field(default=None, max_length=200)


class NoteShareCreateRequest(BaseModel):
    expires_in_days: Optional[int] = Field(
        default=None, ge=1, le=365, description="None = permanent"
    )


class NoteMetaResponse(BaseModel):
    """Note metadata — no content (used in lists)."""

    uuid: str
    title: str
    target_type: str
    target_id: str
    content_length: int
    is_pinned: bool
    revision_count: int
    created_at: datetime
    updated_at: datetime


class NoteDetailResponse(NoteMetaResponse):
    """Note detail with content + anchors + share info."""

    content_md: str
    anchors: list[dict] = Field(default_factory=list)
    share_token: Optional[str] = None
    share_expires_at: Optional[datetime] = None


class NoteAnchorResponse(BaseModel):
    id: int
    block_id: str
    position: int
    label: Optional[str]
    created_at: datetime


class NoteShareResponse(BaseModel):
    share_token: str
    share_url: str
    expires_at: Optional[datetime]


class NoteRevisionResponse(BaseModel):
    revision_id: str
    content_md: str
    revision_note: Optional[str]
    created_at: datetime


class NoteSharedView(BaseModel):
    """Public read-only view (no auth required)."""

    title: str
    content_md: str
    target_type: str
    target_id: str
    shared_at: datetime
    view_count: int
