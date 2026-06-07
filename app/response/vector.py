"""
Pydantic models for vectorization API (vec/page/*).
"""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class VectorPageStatusResponse(BaseModel):
    """GET /vec/page/status response."""
    exists: bool
    bvid: Optional[str] = None
    cid: Optional[int] = None
    page_index: Optional[int] = None
    page_title: Optional[str] = None
    is_processed: bool
    content_preview: Optional[str] = None
    is_vectorized: str  # pending | processing | done | failed
    vectorized_at: Optional[datetime] = None
    vector_chunk_count: int = 0
    vector_error: Optional[str] = None
    steps: Optional[list[dict]] = None


class VectorPageTaskStatus(BaseModel):
    """GET /vec/page/status/{task_id} response."""
    task_id: str
    status: str  # pending | processing | done | failed
    progress: int
    message: str
    steps: Optional[list[dict]] = None
    result: Optional[dict] = None
    error: Optional[str] = None


class VectorPageCreateRequest(BaseModel):
    """POST /vec/page/create request."""
    bvid: str
    cid: int
    page_index: int = 0
    page_title: Optional[str] = None


class VectorPageReVectorRequest(BaseModel):
    """POST /vec/page/revector request."""
    bvid: str
    cid: int
