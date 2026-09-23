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
    board_anchor_text: str = Field(
        default="",
        description="Plain text of the node currently selected on the canvas (panel board chat hint); empty when nothing is selected.",
    )
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

    # ── loop guards (explicit state, maintained by runtime_dispatch) ──
    steps: list[dict] = Field(
        default_factory=list,
        description=(
            "Executed-action ledger: one entry per executed/refused tool call "
            "{tool, args, ok, brief}. Re-injected into every LLM run so the "
            "model knows what it already did, and used by the deterministic "
            "duplicate/budget gates."
        ),
    )
    tool_call_count: int = Field(
        default=0,
        description="Tool calls actually executed this turn (the budget counter).",
    )
    force_finalize: bool = Field(
        default=False,
        description=(
            "Set by runtime_dispatch when every pending call was refused "
            "(duplicates/budget exhausted) — routes the turn to the finalize "
            "node for a forced no-tools answer."
        ),
    )
