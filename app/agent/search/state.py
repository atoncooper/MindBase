"""State for the Search Agent - searches technical documentation."""

from __future__ import annotations

from typing import Annotated

from langgraph.graph.message import add_messages
from pydantic import BaseModel, Field


class SearchAgentState(BaseModel):
    """Search Agent state - resolves library docs via Context7."""

    query: str = Field(description="Search request from the requesting agent.")
    uid: int = Field(default=0, description="User id, injected for tool context.")

    messages: Annotated[list, add_messages] = Field(
        default_factory=list,
        description="System + user + assistant + tool results.",
    )

    result: str = Field(default="", description="Search result returned to the caller.")

    error: str = Field(default="", description="Error message, set on node failure.")
    retry_count: int = Field(default=0)
    failed_node: str = Field(default="")
    max_retries: int = Field(default=2)

    sub_steps: list[dict] = Field(
        default_factory=list,
        description="Tool calls made by this sub-agent (for SSE step reporting).",
    )
