"""Tests for delegate nesting loop prevention.

Verifies that delegate_to_agent rejects delegation back to chat (top-level)
and caps nesting depth, preventing chat -> memory -> chat -> ... loops.
"""

import pytest

from app.tools.harness.delegate import MAX_DELEGATE_DEPTH, DelegateToAgentTool

pytestmark = pytest.mark.asyncio


class _MockLifecycle:
    """Stand-in for AgentLifecycleManager that records invoke_reentrant calls."""

    def __init__(self, result: dict | None = None) -> None:
        self.invoke_reentrant_calls: list[dict] = []
        self._result = result if result is not None else {"result": "ok"}

    async def invoke_reentrant(self, agent_name: str, session_id: str, **kwargs) -> dict:
        self.invoke_reentrant_calls.append(
            {"agent_name": agent_name, "session_id": session_id, **kwargs}
        )
        return self._result


def _make_tool(result: dict | None = None) -> tuple[DelegateToAgentTool, _MockLifecycle]:
    lifecycle = _MockLifecycle(result)
    tool = DelegateToAgentTool(lifecycle)
    return tool, lifecycle


class TestDelegateBlacklist:
    async def test_rejects_delegating_to_chat(self):
        tool, lifecycle = _make_tool()
        result = await tool.run(
            agent_name="chat", query="x", chat_session_id="s1", _uid=None
        )

        assert result["failed"] is True
        assert "chat" in result["content"]
        # lifecycle was NOT called.
        assert lifecycle.invoke_reentrant_calls == []


class TestDelegateDepth:
    async def test_rejects_at_max_depth(self):
        tool, lifecycle = _make_tool()
        result = await tool.run(
            agent_name="memory",
            query="x",
            chat_session_id="s1",
            _uid=None,
            delegate_depth=MAX_DELEGATE_DEPTH,
        )

        assert result["failed"] is True
        assert "深度超限" in result["content"]
        assert lifecycle.invoke_reentrant_calls == []

    async def test_zero_depth_allowed(self):
        tool, lifecycle = _make_tool()
        result = await tool.run(
            agent_name="memory", query="x", chat_session_id="s1", _uid=None, delegate_depth=0
        )

        assert "failed" not in result
        assert result["content"] == "ok"

    async def test_depth_one_allowed(self):
        tool, lifecycle = _make_tool()
        result = await tool.run(
            agent_name="code", query="x", chat_session_id="s1", _uid=None, delegate_depth=1
        )

        assert "failed" not in result

    async def test_passes_incremented_depth(self):
        """delegate_depth=0 -> invoke_reentrant called with delegate_depth=1."""
        tool, lifecycle = _make_tool()
        await tool.run(
            agent_name="memory", query="x", chat_session_id="s1", _uid=None, delegate_depth=0
        )

        assert len(lifecycle.invoke_reentrant_calls) == 1
        assert lifecycle.invoke_reentrant_calls[0]["delegate_depth"] == 1

    async def test_passes_incremented_depth_from_one(self):
        """delegate_depth=1 -> invoke_reentrant called with delegate_depth=2."""
        tool, lifecycle = _make_tool()
        await tool.run(
            agent_name="memory", query="x", chat_session_id="s1", _uid=None, delegate_depth=1
        )

        assert lifecycle.invoke_reentrant_calls[0]["delegate_depth"] == 2
