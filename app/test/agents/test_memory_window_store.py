"""Tests for MemoryWindowStore - per-session sliding window persistence.

Verifies that the window survives across calls within the same session
(the core fix for the "cross-invocation memory loss" bug), enforces the
30-item cap, and isolates sessions.
"""

import pytest

from app.agent.lifecycle.session import SessionManager
from app.agent.memory.state import SEARCH_WINDOW_MAX, make_search_entry
from app.agent.memory.window_store import (
    MemoryWindowStore,
    NullWindowStore,
    SessionWindowStore,
)

pytestmark = pytest.mark.asyncio


def _entry(query: str) -> dict:
    """Build a window entry matching make_search_entry's shape."""
    return make_search_entry(query=query, result=f"result for {query}", tools_used=["get_recent_context"])


class TestSessionWindowStore:
    async def test_load_empty_session_returns_empty(self):
        store = SessionWindowStore(SessionManager())
        assert await store.load("sess-1") == []

    async def test_append_then_load(self):
        store = SessionWindowStore(SessionManager())
        await store.append("sess-1", _entry("q1"))
        window = await store.load("sess-1")
        assert len(window) == 1
        assert window[0]["query"] == "q1"

    async def test_cross_invocation_persistence(self):
        """Two separate load calls (simulating two delegate calls) share state."""
        store = SessionWindowStore(SessionManager())
        await store.append("sess-1", _entry("q1"))
        # Simulate a second delegate call: a fresh load must see the first entry.
        window = await store.load("sess-1")
        assert len(window) == 1
        await store.append("sess-1", _entry("q2"))
        window = await store.load("sess-1")
        assert len(window) == 2
        assert [e["query"] for e in window] == ["q1", "q2"]

    async def test_max_30_truncation(self):
        store = SessionWindowStore(SessionManager())
        for i in range(SEARCH_WINDOW_MAX + 5):
            await store.append("sess-1", _entry(f"q{i}"))
        window = await store.load("sess-1")
        assert len(window) == SEARCH_WINDOW_MAX
        # Oldest entries dropped, most recent retained.
        assert window[0]["query"] == "q5"
        assert window[-1]["query"] == f"q{SEARCH_WINDOW_MAX + 4}"

    async def test_different_sessions_isolated(self):
        store = SessionWindowStore(SessionManager())
        await store.append("sess-1", _entry("q1"))
        await store.append("sess-2", _entry("q2"))
        assert len(await store.load("sess-1")) == 1
        assert len(await store.load("sess-2")) == 1
        assert (await store.load("sess-1"))[0]["query"] == "q1"
        assert (await store.load("sess-2"))[0]["query"] == "q2"

    async def test_empty_session_id_returns_empty(self):
        store = SessionWindowStore(SessionManager())
        assert await store.load("") == []
        # Append with empty session_id is a no-op (does not crash, does not store).
        result = await store.append("", _entry("q1"))
        assert result == []

    async def test_load_returns_copy(self):
        """Mutating the returned list must not affect the stored window."""
        store = SessionWindowStore(SessionManager())
        await store.append("sess-1", _entry("q1"))
        window = await store.load("sess-1")
        window.clear()
        window2 = await store.load("sess-1")
        assert len(window2) == 1

    async def test_append_returns_new_window(self):
        store = SessionWindowStore(SessionManager())
        result = await store.append("sess-1", _entry("q1"))
        assert isinstance(result, list)
        assert len(result) == 1


class TestNullWindowStore:
    async def test_load_returns_empty(self):
        store = NullWindowStore()
        assert await store.load("any") == []

    async def test_append_returns_empty(self):
        store = NullWindowStore()
        assert await store.append("any", _entry("q1")) == []

    async def test_no_state_persisted(self):
        store = NullWindowStore()
        await store.append("sess-1", _entry("q1"))
        assert await store.load("sess-1") == []


class TestProtocol:
    async def test_session_store_satisfies_protocol(self):
        """SessionWindowStore must be a valid MemoryWindowStore (duck-typed)."""
        store: MemoryWindowStore = SessionWindowStore(SessionManager())
        assert isinstance(store, MemoryWindowStore)

    async def test_null_store_satisfies_protocol(self):
        store: MemoryWindowStore = NullWindowStore()
        assert isinstance(store, MemoryWindowStore)
