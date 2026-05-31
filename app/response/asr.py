"""
Pydantic schemas for ASR API — request / response models.
"""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class ASRCreateRequest(BaseModel):
    """POST /asr/create request."""
    bvid: str
    cid: int
    page_index: int = 0
    page_title: Optional[str] = None


class ASRUpdateRequest(BaseModel):
    """POST /asr/update request."""
    bvid: str
    cid: int
    page_index: int
    content: str


class ASRReASRRequest(BaseModel):
    """POST /asr/reasr request."""
    bvid: str
    cid: int
    page_index: int


class ASRContentResponse(BaseModel):
    """GET /asr/content response."""
    exists: bool
    bvid: Optional[str] = None
    cid: Optional[int] = None
    page_index: Optional[int] = None
    page_title: Optional[str] = None
    content: Optional[str] = None
    content_source: Optional[str] = None
    version: Optional[int] = None
    is_processed: Optional[bool] = None


class ASRTaskStatus(BaseModel):
    """ASR task status."""
    task_id: str
    status: str  # pending | processing | done | failed
    progress: int
    message: str


class VideoVersionInfo(BaseModel):
    """ASR version history item."""
    version: int
    content_source: str
    content_preview: str
    is_latest: bool
    created_at: datetime
