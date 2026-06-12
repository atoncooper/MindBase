"""State for the Memory Agent — a retrieval specialist that serves other agents.

The Memory Agent does NOT manage user conversation history.  Instead:

- It maintains its own **30-item sliding window** of search queries and results.
- When another agent (e.g. Chat Agent) asks it to retrieve context, it first
  checks its own window; if it finds a relevant cached result, it returns that
  without re-searching.
- It uses context tools (Redis / MongoDB) only when the window misses.
"""

from __future__ import annotations

import time
from typing import Annotated

from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel, Field

# ── search window entry ────────────────────────────────────────────────

SEARCH_WINDOW_MAX = 30


def make_search_entry(query: str, result: str, tools_used: list[str]) -> dict:
    """Create a new entry for the 30-item sliding search window."""
    return {
        "query": query,
        "result_preview": result[:300] if result else "",
        "tools_used": tools_used,
        "timestamp": time.time(),
    }


def format_search_window(entries: list[dict]) -> str:
    """Format the search window as readable text for the system prompt."""
    if not entries:
        return "（尚无检索记录）"
    lines: list[str] = []
    for i, e in enumerate(reversed(entries[-SEARCH_WINDOW_MAX:]), 1):
        ts = time.strftime("%H:%M", time.localtime(e.get("timestamp", 0)))
        tools = ", ".join(e.get("tools_used", []))
        preview = e.get("result_preview", "")[:200]
        lines.append(f"{i}. [{ts}] 查询: {e['query']}")
        if preview:
            lines.append(f"   结果: {preview}…" if len(preview) >= 200 else f"   结果: {preview}")
        if tools:
            lines.append(f"   工具: {tools}")
    return "\n".join(lines)


def push_search_window(existing: list[dict], entry: dict) -> list[dict]:
    """Append *entry* to the window, keeping at most SEARCH_WINDOW_MAX items."""
    updated = list(existing) + [entry]
    if len(updated) > SEARCH_WINDOW_MAX:
        updated = updated[-SEARCH_WINDOW_MAX:]
    return updated


# ── state ──────────────────────────────────────────────────────────────


class AgentState(BaseModel):
    """Memory Agent state — tracks search queries, results, and its own window.

    This agent is a **retrieval specialist** called by other agents (Chat, RAG,
    etc.).  It does NOT own user conversation history.
    """

    # ── immutable inputs ──────────────────────────────────────────────
    query: str = Field(description="Search query from the requesting agent.")
    target_agent: str = Field(
        default="",
        description="Which agent requested this search (for context).",
    )

    # ── messages (LangGraph reducer for tool-call accumulation) ───────
    messages: Annotated[list, add_messages] = Field(
        default_factory=list,
        description="System + user + assistant + tool results.",
    )

    # ── agent's own 30-item sliding search window ─────────────────────
    search_window: list[dict] = Field(
        default_factory=list,
        description=(
            f"Rolling search memory (max {SEARCH_WINDOW_MAX} entries).  "
            "Each entry has: query, result_preview, tools_used, timestamp."
        ),
    )

    # ── output ────────────────────────────────────────────────────────
    result: str = Field(default="", description="Retrieval result returned to the caller.")

    # ── error handling ────────────────────────────────────────────────
    error: str = Field(default="", description="Error message, set on node failure.")
    retry_count: int = Field(default=0, description="How many retries so far.")
    failed_node: str = Field(default="", description="Node that raised the last error.")
    max_retries: int = Field(default=2, description="Max retries before fallback.")


# ── backward-compatible alias ─────────────────────────────────────────
MemoryAgentState = AgentState
