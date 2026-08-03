"""State for the Code Agent - writes code and runs it in a sandbox."""

from __future__ import annotations

from typing import Annotated

from langgraph.graph.message import add_messages
from pydantic import BaseModel, Field


class CodeAgentState(BaseModel):
    """Code Agent state.

    Called by other agents (via delegate_to_agent) to write code and run it
    in a Daytona sandbox through the run_code tool.
    """

    query: str = Field(description="Code request from the requesting agent.")
    uid: int = Field(default=0, description="User id, injected for run_code tool.")
    chat_session_id: str = Field(
        default="",
        description="Chat session id, threaded from the parent chat agent so "
        "execution records can be associated to the conversation.",
    )
    assistant_msg_id: str = Field(
        default="",
        description="Assistant message id that triggered this code agent "
        "invocation; persisted on each execution record for message-level "
        "traceability.",
    )

    messages: Annotated[list, add_messages] = Field(
        default_factory=list,
        description="System + user + assistant + tool results.",
    )

    result: str = Field(default="", description="Result returned to the caller.")

    error: str = Field(default="", description="Error message, set on node failure.")
    retry_count: int = Field(default=0)
    failed_node: str = Field(default="")
    max_retries: int = Field(default=2)
    max_steps: int = Field(default=8, description="Code may need several fix-run cycles.")
    sub_steps: list[dict] = Field(
        default_factory=list,
        description="Tool calls made by this sub-agent (for SSE step reporting).",
    )
