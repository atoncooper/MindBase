"""Integration tests for the memory agent's cross-invocation window fix.

Verifies that ``inject_window`` and ``update_window`` cooperate via the
``MemoryWindowStore`` so that a window entry written in one delegate call
is visible to a later delegate call within the same session - the core
behaviour that was broken when the window lived only in per-invocation state.
"""

import pytest

from app.agent.lifecycle.session import SessionManager
from app.agent.memory.graph import inject_window, update_window
from app.agent.memory.state import AgentState, make_search_entry
from app.agent.memory.window_store import SessionWindowStore

pytestmark = pytest.mark.asyncio


def _state(query: str, *, session_id: str = "", result: str = "") -> AgentState:
    """Build a minimal AgentState for node-level tests."""
    return AgentState(query=query, caller_session_id=session_id, result=result)


class TestWindowCrossInvocation:
    async def test_update_then_inject_sees_entry(self):
        """update_window persists to the store; a later inject_window loads it."""
        store = SessionWindowStore(SessionManager())

        # First "delegate call": update_window writes an entry.
        state1 = _state("q1", session_id="sess-1", result="result for q1")
        await update_window(state1, window_store=store)

        # Second "delegate call": a fresh state (empty window) loads from store.
        state2 = _state("q2", session_id="sess-1")
        out = await inject_window(state2, window_store=store)

        loaded = out["search_window"]
        assert len(loaded) == 1
        assert loaded[0]["query"] == "q1"
        assert "result for q1" in loaded[0]["result_preview"]

    async def test_update_persists_to_store(self):
        store = SessionWindowStore(SessionManager())
        state = _state("q1", session_id="sess-1", result="r1")
        await update_window(state, window_store=store)
        # The store itself holds the entry (independent of any AgentState).
        loaded = await store.load("sess-1")
        assert len(loaded) == 1
        assert loaded[0]["query"] == "q1"

    async def test_two_calls_accumulate(self):
        """Two sequential delegate calls accumulate entries in the window."""
        store = SessionWindowStore(SessionManager())

        await update_window(_state("q1", session_id="sess-1", result="r1"), window_store=store)
        await update_window(_state("q2", session_id="sess-1", result="r2"), window_store=store)

        out = await inject_window(_state("q3", session_id="sess-1"), window_store=store)
        loaded = out["search_window"]
        assert len(loaded) == 2
        assert [e["query"] for e in loaded] == ["q1", "q2"]


class TestBackwardCompatFallback:
    """Without a store or session_id, nodes fall back to state.search_window."""

    async def test_inject_without_store_uses_state_window(self):
        state = _state("q")
        state.search_window = [make_search_entry("old", "r", [])]
        out = await inject_window(state)  # no window_store
        assert out["search_window"][0]["query"] == "old"

    async def test_inject_with_store_but_no_session_uses_state_window(self):
        store = SessionWindowStore(SessionManager())
        state = _state("q")  # caller_session_id=""
        state.search_window = [make_search_entry("old", "r", [])]
        out = await inject_window(state, window_store=store)
        assert out["search_window"][0]["query"] == "old"

    async def test_update_without_store_appends_to_state_window(self):
        state = _state("q1", result="r1")
        state.search_window = [make_search_entry("old", "r", [])]
        out = await update_window(state)  # no window_store
        assert len(out["search_window"]) == 2

class TestSessionIsolation:
    async def test_different_sessions_do_not_share_window(self):
        store = SessionWindowStore(SessionManager())
        await update_window(_state("q1", session_id="sess-1", result="r1"), window_store=store)
        await update_window(_state("q2", session_id="sess-2", result="r2"), window_store=store)

        out1 = await inject_window(_state("q", session_id="sess-1"), window_store=store)
        out2 = await inject_window(_state("q", session_id="sess-2"), window_store=store)
        assert len(out1["search_window"]) == 1
        assert out1["search_window"][0]["query"] == "q1"
        assert len(out2["search_window"]) == 1
        assert out2["search_window"][0]["query"] == "q2"
