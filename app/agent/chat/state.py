"""ChatAgentState — state model for the ReAct Chat Agent.

The Chat Agent follows the ReAct pattern:
    LLM observes → decides which tool to call → executes → observes result → repeat or answer

This is NOT a deterministic pipeline. The LLM is in the loop and decides
what to do at each step.
"""

from __future__ import annotations

from typing import Annotated

from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel, Field


class ChatAgentState(BaseModel):
    """State flowing through the ReAct Chat Agent graph.

    Inputs (set by the caller):
        query, session_id, uid, folder_ids, workspace_pages, workspace_id, mode

    Intermediate (set by nodes):
        media_ids, bvids, has_data, cloud_has_data, conversation_context,
        search_results (accumulated across multiple tool calls)

    Output (read by the caller):
        messages (the full conversation including tool calls and results),
        sources (deduplicated from all search results),
        result (the final text answer from the LLM)
    """

    # ── immutable inputs ──────────────────────────────────────────────
    query: str = Field(description="User question.")
    session_id: str = Field(default="", description="Chat session ID.")
    uid: int | None = Field(default=None, description="User ID.")
    folder_ids: list[int] = Field(
        default_factory=list, description="Selected favorite folder IDs."
    )
    workspace_pages: list[dict] = Field(
        default_factory=list, description="Workspace selected pages."
    )
    workspace_id: str | None = Field(
        default=None, description="Cloud drive workspace ID."
    )

    # ── intermediate: data resolution (set by inject_context) ──────────
    media_ids: list[int] = Field(
        default_factory=list, description="Resolved favorite folder media IDs."
    )
    bvids: list[str] = Field(default_factory=list, description="Resolved video BV IDs.")
    upload_uuids: list[str] = Field(
        default_factory=list, description="Inherited cloud document UUIDs from last turn."
    )
    has_data: bool = Field(default=False, description="Whether B站 data exists.")
    cloud_has_data: bool = Field(
        default=False, description="Whether cloud backend is available."
    )
    conversation_context: str = Field(
        default="", description="Injected conversation context."
    )

    # ── messages (LangGraph reducer for tool-call accumulation) ───────
    messages: Annotated[list, add_messages] = Field(
        default_factory=list,
        description="System + user + assistant + tool messages (ReAct loop).",
    )

    # ── intermediate: accumulated search results ─────────────────────
    search_results: list[dict] = Field(
        default_factory=list,
        description="Accumulated search results across tool calls (for source tracking).",
    )

    # ── output ────────────────────────────────────────────────────────
    result: str = Field(default="", description="Final answer text from the LLM.")
    sources: list[dict] = Field(
        default_factory=list, description="Deduplicated source metadata."
    )

    # ── error handling ────────────────────────────────────────────────
    error: str = Field(default="", description="Error message set on node failure.")
    retry_count: int = Field(default=0)
    failed_node: str = Field(default="")
    max_retries: int = Field(default=2)

    # ── loop protection ───────────────────────────────────────────────
    step_count: int = Field(default=0, description="ReAct loop iteration counter.")
    max_steps: int = Field(default=10, description="Hard limit on ReAct iterations.")


class ChatAgentResult(BaseModel):
    """Structured output returned by the Chat Agent."""

    result: str = ""
    messages: list[BaseMessage] = Field(default_factory=list)
    sources: list[dict] = Field(default_factory=list)
    error: str = ""
