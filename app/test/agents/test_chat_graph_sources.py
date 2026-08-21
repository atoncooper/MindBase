"""Tests for the runtime_dispatch sources accumulation contract.

The chat ReAct graph relies on this chain:

    VectorSearchTool returns dict(content, sources)
        → AgentRuntime lifts ``sources`` into ToolMessage.additional_kwargs
        → runtime_dispatch harvests them into ``state.search_results``
        → format_result deduplicates and emits the final ``sources`` list

These tests target the harvesting + dedup boundaries so a regression in
either the runtime payload shape or the graph reducer surfaces here
before users notice missing citations.
"""

from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from app.agent.chat.graph import format_result, runtime_dispatch
from app.agent.chat.state import ChatAgentState
from app.harness.runtime import AgentRuntime, ToolMetrics
from app.tools.registry import ToolRegistry


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _SourceTool:
    """Tool that emits configurable sources via dict return shape."""

    def __init__(self, name: str, sources: list[dict], content: str = "ok") -> None:
        self._name = name
        self._sources = sources
        self._content = content

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return f"emits sources for {self._name}"

    def parameters(self) -> dict:
        return {"type": "object", "properties": {"q": {"type": "string"}}}

    async def run(self, **kwargs):  # noqa: D401
        return {"content": self._content, "sources": list(self._sources)}


def _make_runtime(tools) -> AgentRuntime:
    registry = ToolRegistry()
    for t in tools:
        registry.register(t)
    runtime = AgentRuntime(registry)
    runtime._metrics = {n: ToolMetrics() for n in registry.list()}
    runtime._started = True
    return runtime


def _state_with_tool_call(tool_name: str, *, search_results=None) -> ChatAgentState:
    return ChatAgentState(
        query="q",
        session_id="sess-1",
        messages=[
            SystemMessage(content="sys"),
            HumanMessage(content="q"),
            AIMessage(
                content="",
                tool_calls=[
                    {"id": "tc1", "name": tool_name, "args": {"q": "q"}}
                ],
            ),
        ],
        search_results=search_results or [],
    )


# ---------------------------------------------------------------------------
# runtime_dispatch — sources merged into search_results
# ---------------------------------------------------------------------------


class TestRuntimeDispatchSources:
    @pytest.mark.asyncio
    async def test_sources_are_merged_into_search_results(self) -> None:
        sources = [{"bvid": "BV1", "title": "T1"}]
        runtime = _make_runtime([_SourceTool("vector_search", sources)])
        state = _state_with_tool_call("vector_search")

        update = await runtime_dispatch(state, runtime=runtime)

        assert "search_results" in update
        assert update["search_results"] == sources
        assert update["step_count"] == state.step_count + 1

    @pytest.mark.asyncio
    async def test_existing_search_results_are_preserved(self) -> None:
        prior = [{"bvid": "BV0", "title": "T0"}]
        new = [{"bvid": "BV1", "title": "T1"}]
        runtime = _make_runtime([_SourceTool("vector_search", new)])
        state = _state_with_tool_call("vector_search", search_results=prior)

        update = await runtime_dispatch(state, runtime=runtime)

        # Previous + new, in that order — dedup is the responsibility of format_result
        assert update["search_results"] == prior + new

    @pytest.mark.asyncio
    async def test_no_sources_field_when_tool_returns_none(self) -> None:
        # Tool returns sources=[] → no merge update should be emitted
        runtime = _make_runtime([_SourceTool("vector_search", [])])
        state = _state_with_tool_call("vector_search")

        update = await runtime_dispatch(state, runtime=runtime)

        assert "search_results" not in update
        assert "messages" in update
        assert update["step_count"] == state.step_count + 1

    @pytest.mark.asyncio
    async def test_skips_tool_calls_already_executed(self) -> None:
        """If a ToolMessage with the same call_id exists, don't re-dispatch."""
        runtime = _make_runtime([_SourceTool("vector_search", [{"bvid": "BV1"}])])
        state = ChatAgentState(
            query="q",
            messages=[
                SystemMessage(content="sys"),
                HumanMessage(content="q"),
                AIMessage(
                    content="",
                    tool_calls=[
                        {"id": "tc1", "name": "vector_search", "args": {"q": "q"}}
                    ],
                ),
                ToolMessage(content="prior", tool_call_id="tc1"),
            ],
        )

        update = await runtime_dispatch(state, runtime=runtime)
        assert update == {}

    @pytest.mark.asyncio
    async def test_implicit_kwargs_injected_from_state(self) -> None:
        """``_bvids``, ``_uid``, ``_workspace_pages``, etc. should reach the tool."""
        captured: dict = {}

        class _CaptureTool:
            name = "vector_search"
            description = "capture"

            def parameters(self) -> dict:
                return {"type": "object", "properties": {}}

            async def run(self, **kwargs):
                captured.update(kwargs)
                return {"content": "ok", "sources": []}

        runtime = _make_runtime([_CaptureTool()])
        state = ChatAgentState(
            query="q",
            session_id="sess-xyz",
            uid=42,
            bvids=["BV1", "BV2"],
            media_ids=[10, 20],
            workspace_pages=[{"bvid": "BV1", "cid": 99}],
            messages=[
                SystemMessage(content="sys"),
                HumanMessage(content="q"),
                AIMessage(
                    content="",
                    tool_calls=[
                        {"id": "tc1", "name": "vector_search", "args": {"q": "q"}}
                    ],
                ),
            ],
        )

        await runtime_dispatch(state, runtime=runtime)

        assert captured["chat_session_id"] == "sess-xyz"
        assert captured["_uid"] == 42
        assert captured["_bvids"] == ["BV1", "BV2"]
        assert captured["_media_ids"] == [10, 20]
        assert captured["_workspace_pages"] == [{"bvid": "BV1", "cid": 99}]


# ---------------------------------------------------------------------------
# format_result — dedup
# ---------------------------------------------------------------------------


class TestFormatResultDedup:
    @pytest.mark.asyncio
    async def test_dedup_by_bvid(self) -> None:
        state = ChatAgentState(
            query="q",
            search_results=[
                {"bvid": "BV1", "title": "T1"},
                {"bvid": "BV1", "title": "T1"},  # duplicate
                {"bvid": "BV2", "title": "T2"},
            ],
        )
        update = await format_result(state)
        bvids = [s["bvid"] for s in update["sources"]]
        assert bvids == ["BV1", "BV2"]

    @pytest.mark.asyncio
    async def test_dedup_by_upload_uuid(self) -> None:
        state = ChatAgentState(
            query="q",
            search_results=[
                {"upload_uuid": "u1", "title": "C1"},
                {"upload_uuid": "u1", "title": "C1"},
                {"upload_uuid": "u2", "title": "C2"},
            ],
        )
        update = await format_result(state)
        ids = [s["upload_uuid"] for s in update["sources"]]
        assert ids == ["u1", "u2"]

    @pytest.mark.asyncio
    async def test_skips_sources_without_identifier(self) -> None:
        state = ChatAgentState(
            query="q",
            search_results=[
                {"title": "无标识1"},
                {"bvid": "BV1", "title": "T1"},
                {"title": "无标识2"},
            ],
        )
        update = await format_result(state)
        assert update["sources"] == [{"bvid": "BV1", "title": "T1"}]

    @pytest.mark.asyncio
    async def test_empty_search_results_yields_empty_sources(self) -> None:
        state = ChatAgentState(query="q")
        update = await format_result(state)
        assert update["sources"] == []

    @pytest.mark.asyncio
    async def test_mixed_bvid_and_upload_uuid_preserved(self) -> None:
        state = ChatAgentState(
            query="q",
            search_results=[
                {"bvid": "BV1", "title": "T1"},
                {"upload_uuid": "u1", "title": "C1"},
            ],
        )
        update = await format_result(state)
        assert len(update["sources"]) == 2
