"""Unit tests for AgentRuntime — focused on the dict-shaped tool result
contract introduced for the ReAct chat agent.

The harness's ``_split_tool_result`` is the boundary that lifts structured
extras (e.g. ``sources``) out of a tool's dict return into
``ToolMessage.additional_kwargs``. The chat graph then merges those
``additional_kwargs.sources`` into ``state.search_results``. Breaking
this contract silently drops citations from the SSE stream.
"""

from __future__ import annotations

import pytest
from langchain_core.messages import ToolMessage

from app.harness.runtime import AgentRuntime, ToolMetrics, _split_tool_result
from app.tools.registry import ToolRegistry


# ---------------------------------------------------------------------------
# _split_tool_result
# ---------------------------------------------------------------------------


class TestSplitToolResult:
    def test_dict_with_content_and_extras(self) -> None:
        raw = {"content": "hello", "sources": [{"bvid": "BV1"}], "score": 0.9}
        content, extras = _split_tool_result(raw)
        assert content == "hello"
        assert extras == {"sources": [{"bvid": "BV1"}], "score": 0.9}

    def test_dict_without_content_yields_empty_string(self) -> None:
        raw = {"sources": [{"bvid": "BV1"}]}
        content, extras = _split_tool_result(raw)
        assert content == ""
        assert extras == {"sources": [{"bvid": "BV1"}]}

    def test_dict_with_only_content(self) -> None:
        raw = {"content": "answer"}
        content, extras = _split_tool_result(raw)
        assert content == "answer"
        assert extras == {}

    def test_empty_dict(self) -> None:
        content, extras = _split_tool_result({})
        assert content == ""
        assert extras == {}

    def test_string_input(self) -> None:
        content, extras = _split_tool_result("plain text")
        assert content == "plain text"
        assert extras == {}

    def test_none_input(self) -> None:
        content, extras = _split_tool_result(None)
        assert content == "None"
        assert extras == {}

    def test_int_input_coerces_to_str(self) -> None:
        content, extras = _split_tool_result(42)
        assert content == "42"
        assert extras == {}

    def test_dict_content_coerced_to_str(self) -> None:
        """Non-string ``content`` value should still be coerced via str()."""
        raw = {"content": 42, "sources": []}
        content, extras = _split_tool_result(raw)
        assert content == "42"
        assert extras == {"sources": []}


# ---------------------------------------------------------------------------
# AgentRuntime._execute_one — ToolMessage carries additional_kwargs
# ---------------------------------------------------------------------------


class _DictTool:
    """Tool that returns a dict with ``content`` + ``sources``."""

    name = "dict_tool"
    description = "returns dict"

    def parameters(self) -> dict:
        return {"type": "object", "properties": {}}

    async def run(self, **kwargs):  # noqa: D401
        return {"content": "结果文本", "sources": [{"bvid": "BV1", "title": "T1"}]}


class _StrTool:
    name = "str_tool"
    description = "returns str"

    def parameters(self) -> dict:
        return {"type": "object", "properties": {}}

    async def run(self, **kwargs):
        return "纯字符串"


class _RaisingTool:
    name = "raising_tool"
    description = "raises"

    def parameters(self) -> dict:
        return {"type": "object", "properties": {}}

    async def run(self, **kwargs):
        raise RuntimeError("boom")


def _make_runtime(tools) -> AgentRuntime:
    registry = ToolRegistry()
    for t in tools:
        registry.register(t)
    runtime = AgentRuntime(registry)
    runtime._metrics = {name: ToolMetrics() for name in registry.list()}
    runtime._started = True
    return runtime


class TestExecuteOne:
    @pytest.mark.asyncio
    async def test_dict_tool_lifts_extras_into_additional_kwargs(self) -> None:
        runtime = _make_runtime([_DictTool()])
        msgs = await runtime.execute(
            [{"id": "tc1", "name": "dict_tool", "args": {}}]
        )

        assert len(msgs) == 1
        msg = msgs[0]
        assert isinstance(msg, ToolMessage)
        assert msg.tool_call_id == "tc1"
        assert msg.name == "dict_tool"
        assert msg.content == "结果文本"
        assert msg.additional_kwargs == {
            "sources": [{"bvid": "BV1", "title": "T1"}]
        }

    @pytest.mark.asyncio
    async def test_str_tool_has_empty_additional_kwargs(self) -> None:
        runtime = _make_runtime([_StrTool()])
        msgs = await runtime.execute(
            [{"id": "tc1", "name": "str_tool", "args": {}}]
        )
        assert msgs[0].content == "纯字符串"
        assert msgs[0].additional_kwargs == {}

    @pytest.mark.asyncio
    async def test_raising_tool_yields_error_tool_message(self) -> None:
        runtime = _make_runtime([_RaisingTool()])
        msgs = await runtime.execute(
            [{"id": "tc1", "name": "raising_tool", "args": {}}]
        )

        assert len(msgs) == 1
        assert isinstance(msgs[0], ToolMessage)
        assert msgs[0].tool_call_id == "tc1"
        assert "工具执行失败" in msgs[0].content
        assert "boom" in msgs[0].content

    @pytest.mark.asyncio
    async def test_concurrent_dispatch_preserves_call_id_mapping(self) -> None:
        runtime = _make_runtime([_DictTool(), _StrTool()])
        msgs = await runtime.execute(
            [
                {"id": "a", "name": "dict_tool", "args": {}},
                {"id": "b", "name": "str_tool", "args": {}},
            ]
        )
        ids = [m.tool_call_id for m in msgs]
        assert ids == ["a", "b"]

    @pytest.mark.asyncio
    async def test_empty_tool_calls_returns_empty(self) -> None:
        runtime = _make_runtime([_StrTool()])
        msgs = await runtime.execute([])
        assert msgs == []

    @pytest.mark.asyncio
    async def test_unstarted_runtime_raises(self) -> None:
        registry = ToolRegistry()
        registry.register(_StrTool())
        runtime = AgentRuntime(registry)  # NOT started
        with pytest.raises(RuntimeError, match="not started"):
            await runtime.execute([{"id": "tc1", "name": "str_tool", "args": {}}])
