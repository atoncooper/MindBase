"""
Pydantic schemas for chat API — request / response models.
"""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class WorkspacePage(BaseModel):
    """A selected vectorized page in the user's workspace."""
    bvid: str
    cid: int
    page_index: int = 0
    page_title: Optional[str] = None


class ChatRequest(BaseModel):
    """POST /chat/ask request."""
    question: str
    session_id: Optional[str] = None
    chat_session_id: Optional[str] = None
    folder_ids: Optional[list[int]] = None
    workspace_pages: Optional[list[WorkspacePage]] = None
    mode: str = "standard"  # standard | agentic


class ChatResponse(BaseModel):
    """POST /chat/ask response (non-streaming)."""
    answer: str
    sources: list[dict]


class ReasoningStepResponse(BaseModel):
    """Agentic RAG multi-hop reasoning step."""
    step: int
    action: str
    query: str = ""
    reasoning: str = ""
    verdict: Optional[str] = None
    recall_score: Optional[float] = None
    sources: list[dict] = []
    content_preview: str = ""


class AgenticChatResponse(BaseModel):
    """POST /chat/ask/agentic response."""
    answer: str
    sources: list[dict]
    reasoning_steps: list[ReasoningStepResponse]
    synthesis_method: str
    hops_used: int
    avg_recall_score: float = 0.0


class ChatSessionCreateRequest(BaseModel):
    """POST /chat/sessions request."""
    title: Optional[str] = None


class ChatSessionUpdateRequest(BaseModel):
    """PATCH /chat/sessions/{id} request."""
    title: str


class ChatSessionResponse(BaseModel):
    """Chat session item."""
    id: int
    chat_session_id: str
    uid: Optional[int] = None
    title: Optional[str] = None
    status: str = "active"
    created_at: datetime
    updated_at: datetime
    last_message_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ChatSessionListResponse(BaseModel):
    """GET /chat/sessions response."""
    sessions: list[ChatSessionResponse]


class ChatMessageResponse(BaseModel):
    """Chat message item."""
    msg_id: str
    chat_session_id: str
    role: str
    content: str
    status: str = "completed"
    sources: Optional[list[dict]] = None
    tokens_used: Optional[int] = None
    model: Optional[str] = None
    latency_ms: Optional[int] = None
    error: Optional[str] = None
    created_at: datetime


class ChatHistoryQueryParams(BaseModel):
    """GET /chat/history query params."""
    chat_session_id: str
    page: int = 1
    page_size: int = 50


class ChatHistoryResponse(BaseModel):
    """GET /chat/history response."""
    messages: list[ChatMessageResponse]
    total: int
    page: int
    page_size: int
    has_more: bool
