"""Memory Agent — a retrieval specialist for other agents.

This agent is NOT a chat agent.  It serves other agents (Chat Agent, RAG Agent,
etc.) by searching conversation context across multiple backends (InMemory,
Redis, MongoDB).

Key design points:

* **Owns a 30-item sliding window** of its own search history, so repeated
  queries return cached results without re-searching.
* **No user conversation management** — it doesn't inject or persist user
  chat history.  That's the calling agent's responsibility.
* **Tools are executed by AgentRuntime**, not by the graph directly.
* **Called via AgentLifecycleManager**, not directly by HTTP routes.

Architecture::

    START → inject_window → agent ──(tool_calls)──→ runtime_dispatch → agent (loop)
                              │                          │
                              │                    [AgentRuntime.execute()]
                              │                          │
                              └──(respond)──→ update_window → END

    error_node ◄──(error on any node)──────────┘
        ├── retry (backoff) → failed_node
        └── fallback → update_window

Registration::

    from app.agent.lifecycle import AgentLifecycleManager
    from app.agent.memory import build_memory_agent

    manager = AgentLifecycleManager()
    manager.register("memory", build_memory_agent, runtime=runtime, llm=llm)
    result = await manager.invoke("memory", session_id="abc", query="...")
"""

from .graph import build_memory_agent, create_memory_agent
from .handlers import FALLBACK_RESULT, ErrorCategory, classify_error
from .state import (
    SEARCH_WINDOW_MAX,
    AgentState,
    MemoryAgentState,
    format_search_window,
    make_search_entry,
    push_search_window,
)

__all__ = [
    "AgentState",
    "MemoryAgentState",
    "SEARCH_WINDOW_MAX",
    "format_search_window",
    "make_search_entry",
    "push_search_window",
    "build_memory_agent",
    "create_memory_agent",
    "ErrorCategory",
    "classify_error",
    "FALLBACK_RESULT",
]
