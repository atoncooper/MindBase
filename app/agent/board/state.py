"""State for the Board Agent — create / explain / refine boards via MCP tools."""

from __future__ import annotations

from typing import Annotated

from langgraph.graph.message import add_messages
from pydantic import BaseModel, Field


class BoardAgentState(BaseModel):
    """Board Agent state.

    Invoked as a top-level route target (chat conversations mentioning boards)
    or directly with ``board_uuid`` when the request comes from the board
    panel's board chat.
    """

    # ── immutable inputs ──────────────────────────────────────────────
    query: str = Field(description="User request about boards.")
    uid: int = Field(default=0, description="User id, injected for board MCP tools.")
    board_uuid: str = Field(default="", description="Board the request is scoped to (panel board chat); empty for open-ended chat.")
    session_id: str = Field(default="", description="Chat session id, used to load conversation history.")

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
