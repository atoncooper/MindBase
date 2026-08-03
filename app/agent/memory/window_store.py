"""Sliding search-window store for the Memory Agent.

The Memory Agent keeps a 30-item sliding window of past queries + results
so it can short-circuit repeat lookups.  The window must survive across
delegate calls within the same chat session, so it cannot live in the
per-invocation ``AgentState`` (which is reinitialised on every
``agent.ainvoke(input)``).  Instead it is persisted per-session via a
``MemoryWindowStore``.

The default implementation ``SessionWindowStore`` stashes the window on
``SessionState.meta`` (in-memory, auto-cleaned by the session TTL).  A
future ``RedisWindowStore`` can swap in without touching the graph, since
the graph only depends on the ``MemoryWindowStore`` protocol.

Concurrency: the window is a best-effort cache.  Concurrent ``append``
calls for the same session may drop or duplicate an entry (read-modify-
write is not atomic), but this is acceptable because a miss simply
degrades to a full search - correctness is unaffected.
"""

from __future__ import annotations

import logging
from typing import Any, Protocol, runtime_checkable

from app.agent.lifecycle.session import SessionManager
from app.agent.memory.state import push_search_window

logger = logging.getLogger(__name__)

# Key under which the window is stored on SessionState.meta.
WINDOW_META_KEY = "memory_search_window"


@runtime_checkable
class MemoryWindowStore(Protocol):
    """Per-session sliding window of memory-agent searches."""

    async def load(self, session_id: str) -> list[dict[str, Any]]:
        """Load the window for *session_id* (empty list if none)."""
        ...

    async def append(
        self, session_id: str, entry: dict[str, Any]
    ) -> list[dict[str, Any]]:
        """Append *entry*, truncate to SEARCH_WINDOW_MAX, return the new window."""
        ...


class NullWindowStore:
    """No-op store - returns empty windows.

    Used as the default when no store is wired, so the graph degrades to
    the previous (windowless) behaviour without crashing.
    """

    async def load(self, session_id: str) -> list[dict[str, Any]]:
        return []

    async def append(
        self, session_id: str, entry: dict[str, Any]
    ) -> list[dict[str, Any]]:
        return []


class SessionWindowStore:
    """Persist the window on ``SessionState.meta`` (in-memory, per-session).

    Pros: zero new dependencies, auto-cleaned by ``SessionManager.cleanup_expired``.
    Cons: lost on process restart (acceptable - window is a cache).
    """

    def __init__(self, sessions: SessionManager) -> None:
        self._sessions = sessions

    async def load(self, session_id: str) -> list[dict[str, Any]]:
        if not session_id:
            return []
        state = self._sessions.get_or_create(session_id)
        window = state.meta.get(WINDOW_META_KEY, [])
        # Shallow copy so callers cannot mutate the stored list directly.
        return list(window)

    async def append(
        self, session_id: str, entry: dict[str, Any]
    ) -> list[dict[str, Any]]:
        if not session_id:
            return []
        state = self._sessions.get_or_create(session_id)
        current = state.meta.get(WINDOW_META_KEY, [])
        updated = push_search_window(current, entry)
        state.meta[WINDOW_META_KEY] = updated
        logger.debug(
            "[MEM_WINDOW] appended session=%s window_size=%s",
            session_id,
            len(updated),
        )
        return list(updated)
