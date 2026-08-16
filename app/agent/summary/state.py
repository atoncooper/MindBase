"""State for the Summary Agent - detailed summaries of a chat session."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from langgraph.graph.message import add_messages
from pydantic import BaseModel, Field


class SummaryAgentState(BaseModel):
    """Summary Agent state.

    Triggered by the session-summary HTTP endpoint (frontend button), not by
    chat routing. Fetches the full conversation history itself in the inject
    node and produces a detailed Markdown summary in a single LLM call.
    """

    # ── immutable inputs ──────────────────────────────────────────────
    chat_session_id: str = Field(description="Chat session to summarize.")
    uid: int = Field(default=0, description="Owning user id.")
    query: str = Field(
        default="请总结当前会话",
        description="Summarization instruction from the requesting endpoint.",
    )

    # ── messages (LangGraph reducer for accumulation) ─────────────────
    messages: Annotated[list, add_messages] = Field(
        default_factory=list,
        description="System + user (formatted history) + assistant summary.",
    )

    # ── output ────────────────────────────────────────────────────────
    result: str = Field(default="", description="Summary returned to the caller.")
    message_count: int = Field(default=0, description="Number of messages summarized.")
    first_message_at: datetime | None = Field(
        default=None, description="Timestamp of the earliest summarized message."
    )
    last_message_at: datetime | None = Field(
        default=None, description="Timestamp of the latest summarized message."
    )

    # ── error handling ────────────────────────────────────────────────
    error: str = Field(default="", description="Error message, set on node failure.")
    retry_count: int = Field(default=0)
    failed_node: str = Field(default="")
    max_retries: int = Field(default=2)
