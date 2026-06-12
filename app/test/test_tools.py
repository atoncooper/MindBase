"""Tests for the tool layer (app/tools/) and runtime (app/harness/runtime.py).

Covers:

- BaseTool protocol structural typing
- ToolRegistry: register, get, list, for_agent
- Context tool instantiation (no real infra needed — mock dependencies)
- AgentRuntime: execute, monitor, lifecycle
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import ToolMessage

from app.harness.runtime import AgentRuntime, ToolMetrics
from app.tools import BaseTool, ToolRegistry


# ===========================================================================
# ToolRegistry
# ===========================================================================


class _DummyTool:
    """A minimal BaseTool-compatible class for testing."""

    @property
    def name(self) -> str:
        return "dummy"

    @property
    def description(self) -> str:
        return "A dummy tool for testing."

    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "msg": {"type": "string", "description": "A message."},
            },
            "required": ["msg"],
        }

    async def run(self, msg: str = "", **kwargs) -> str:
        return f"ran: {msg}"


class TestToolRegistry:
    def test_register_and_get(self):
        registry = ToolRegistry()
        tool = _DummyTool()
        registry.register(tool)
        assert registry.get("dummy") is tool

    def test_get_missing_raises(self):
        registry = ToolRegistry()
        with pytest.raises(KeyError):
            registry.get("nonexistent")

    def test_list(self):
        registry = ToolRegistry()
        registry.register(_DummyTool())
        assert registry.list() == ["dummy"]

    def test_register_overwrite_warning(self):
        registry = ToolRegistry()
        registry.register(_DummyTool())
        registry.register(_DummyTool())  # should warn, not error

    def test_unregister(self):
        registry = ToolRegistry()
        registry.register(_DummyTool())
        assert registry.unregister("dummy") is True
        assert registry.list() == []

    def test_unregister_missing(self):
        registry = ToolRegistry()
        assert registry.unregister("ghost") is False

    def test_protocol_check(self):
        """Verify that a class matching BaseTool protocol passes runtime_checkable."""
        assert isinstance(_DummyTool(), BaseTool)

    def test_for_agent_output(self):
        """for_agent() returns LangChain-compatible tool definitions."""
        registry = ToolRegistry()
        registry.register(_DummyTool())
        defs = registry.for_agent()
        assert len(defs) == 1
        st = defs[0]
        assert st.name == "dummy"
        assert st.description == "A dummy tool for testing."


# ===========================================================================
# AgentRuntime
# ===========================================================================


class TestAgentRuntime:
    @pytest.fixture
    def registry(self):
        reg = ToolRegistry()
        reg.register(_DummyTool())
        return reg

    @pytest.fixture
    def runtime(self, registry):
        rt = AgentRuntime(registry)
        return rt

    @pytest.mark.asyncio
    async def test_start_stop(self, runtime):
        await runtime.start()
        assert runtime.started is True
        await runtime.stop()
        assert runtime.started is False

    @pytest.mark.asyncio
    async def test_execute_success(self, runtime):
        await runtime.start()
        tool_calls = [
            {"id": "call_1", "name": "dummy", "args": {"msg": "hello"}},
        ]
        results = await runtime.execute(tool_calls)
        assert len(results) == 1
        msg = results[0]
        assert isinstance(msg, ToolMessage)
        assert msg.tool_call_id == "call_1"
        assert "ran: hello" in msg.content

    @pytest.mark.asyncio
    async def test_execute_missing_tool(self, runtime):
        await runtime.start()
        tool_calls = [
            {"id": "call_x", "name": "ghost", "args": {}},
        ]
        results = await runtime.execute(tool_calls)
        assert len(results) == 1
        msg = results[0]
        assert "ghost" in msg.content or "失败" in msg.content
        # Should still have tool_call_id
        assert msg.tool_call_id == "call_x"

    @pytest.mark.asyncio
    async def test_execute_empty(self, runtime):
        results = await runtime.execute([])
        assert results == []

    @pytest.mark.asyncio
    async def test_execute_multiple_concurrent(self, runtime):
        await runtime.start()
        tool_calls = [
            {"id": "c1", "name": "dummy", "args": {"msg": "first"}},
            {"id": "c2", "name": "dummy", "args": {"msg": "second"}},
        ]
        results = await runtime.execute(tool_calls)
        assert len(results) == 2
        assert results[0].tool_call_id == "c1"
        assert results[1].tool_call_id == "c2"

    @pytest.mark.asyncio
    async def test_monitor_metrics(self, runtime):
        await runtime.start()
        tool_calls = [{"id": "c1", "name": "dummy", "args": {"msg": "hi"}}]
        await runtime.execute(tool_calls)
        await runtime.execute(tool_calls)

        stats = runtime.monitor()
        assert stats["totals"]["call_count"] == 2
        assert stats["totals"]["error_count"] == 0
        assert "dummy" in stats["tools"]
        assert stats["tools"]["dummy"]["call_count"] == 2

    @pytest.mark.asyncio
    async def test_list_tool_defs(self, runtime):
        defs = runtime.list_tool_defs()
        assert len(defs) == 1
        assert defs[0].name == "dummy"

    @pytest.mark.asyncio
    async def test_list_tool_defs_cached(self, runtime):
        """list_tool_defs() should cache and reuse."""
        defs1 = runtime.list_tool_defs()
        defs2 = runtime.list_tool_defs()
        assert defs1 is defs2  # same object (cached)


# ===========================================================================
# Tool instantiation (lightweight — no real infra)
# ===========================================================================


class TestContextTools:
    """Verify that context tools can be instantiated with mock dependencies."""

    @pytest.mark.asyncio
    async def test_get_recent_context_tool(self):
        from unittest.mock import AsyncMock

        ctx_mgr = AsyncMock()
        ctx_mgr.get_context_raw.return_value = []

        from app.tools.context import GetRecentContextTool

        tool = GetRecentContextTool(ctx_mgr)
        assert tool.name == "get_recent_context"
        assert "memory" in tool.description.lower()

        result = await tool.run(chat_session_id="s1")
        assert "尚无对话记录" in result

    @pytest.mark.asyncio
    async def test_get_compressed_summary_tool(self):
        from app.tools.context import GetCompressedSummaryTool

        tool = GetCompressedSummaryTool()
        assert tool.name == "get_compressed_summary"
        # No Redis available in test — should return "not found"
        result = await tool.run(chat_session_id="s1")
        assert isinstance(result, str)

    @pytest.mark.asyncio
    async def test_get_full_history_tool(self):
        from app.tools.context import GetFullHistoryTool

        tool = GetFullHistoryTool()
        assert tool.name == "get_full_history"
        # No MongoDB in test — should return "not found"
        result = await tool.run(chat_session_id="s1")
        assert isinstance(result, str)

    @pytest.mark.asyncio
    async def test_search_chat_history_tool(self):
        from unittest.mock import AsyncMock

        ctx_mgr = AsyncMock()
        from app.tools.context import SearchChatHistoryTool

        tool = SearchChatHistoryTool(ctx_mgr)
        assert tool.name == "search_chat_history"
        result = await tool.run(chat_session_id="s1", query="test")
        assert isinstance(result, str)

    def test_all_tool_params(self):
        """Verify each tool declares correct parameters."""
        from app.tools.context import (
            GetCompressedSummaryTool,
            GetFullHistoryTool,
            GetRecentContextTool,
            SearchChatHistoryTool,
        )

        from unittest.mock import AsyncMock

        ctx_mgr = AsyncMock()

        tools = [
            SearchChatHistoryTool(ctx_mgr),
            GetRecentContextTool(ctx_mgr),
            GetCompressedSummaryTool(),
            GetFullHistoryTool(),
        ]

        for tool in tools:
            params = tool.parameters()
            assert "properties" in params
            assert "chat_session_id" in params["properties"], f"{tool.name} missing chat_session_id"
