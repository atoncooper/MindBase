"""Pydantic schemas for code execution records.

List views exclude the heavy ``code`` / ``stdout`` / ``artifacts`` fields
(they can be large); the detail view includes them. ``CodeExecutionResponse``
extends the list item so the two stay field-compatible.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class CodeExecutionArtifact(BaseModel):
    """One binary artifact extracted from a run_code execution."""

    name: str
    minio_key: Optional[str] = None
    url: Optional[str] = None
    content_type: Optional[str] = None
    size: Optional[int] = None


class CodeExecutionListItem(BaseModel):
    """List view - excludes heavy code/stdout/artifacts fields."""

    exec_id: str
    uid: int
    chat_session_id: str
    assistant_msg_id: str
    delegate_query: str
    language: str
    exit_code: int
    latency_ms: int
    error: Optional[str] = None
    timeout: bool = False
    artifact_count: int = 0
    created_at: datetime


class CodeExecutionListResponse(BaseModel):
    items: list[CodeExecutionListItem]
    total: int
    page: int
    page_size: int


class CodeExecutionResponse(CodeExecutionListItem):
    """Detail view - includes full code, stdout, and artifacts."""

    code: str = ""
    stdout: str = ""
    artifacts: list[CodeExecutionArtifact] = Field(default_factory=list)
