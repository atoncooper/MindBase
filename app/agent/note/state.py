"""State for the Note Agent - composes Markdown notes and saves them."""

from __future__ import annotations

from typing import Annotated

from langgraph.graph.message import add_messages
from pydantic import BaseModel, Field


class NoteAgentState(BaseModel):
    """Note Agent state.

    Called by other agents (via delegate_to_agent) to compose a Markdown note
    from the conversation and persist it via the save_note tool.
    """

    # ── immutable inputs ──────────────────────────────────────────────
    query: str = Field(description="Note request from the requesting agent.")
    uid: int = Field(default=0, description="User id, injected for save_note tool.")

    # ── messages (LangGraph reducer for tool-call accumulation) ───────
    messages: Annotated[list, add_messages] = Field(
        default_factory=list,
        description="System + user + assistant + tool results.",
    )

    # ── output ────────────────────────────────────────────────────────
    result: str = Field(default="", description="Result returned to the caller.")

    # ── error handling ────────────────────────────────────────────────
    error: str = Field(default="", description="Error message, set on node failure.")
    retry_count: int = Field(default=0)
    failed_node: str = Field(default="")
    max_retries: int = Field(default=2)
