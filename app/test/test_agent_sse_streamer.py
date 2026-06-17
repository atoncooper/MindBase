"""Unit tests for AgentSSEStreamer (app/services/chat/agent_sse.py).

The streamer translates ``CompiledGraph.astream_events(version="v2")``
into the legacy SSE protocol the frontend already speaks. The two
non-trivial responsibilities are:

1. Parsing tool outputs (string JSON or dict) to extract ``sources``.
2. Threading sources through ``on_tool_end`` events into a final
   deduplicated ``sources`` frame, even when multiple tool calls produce
   overlapping payloads.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

import pytest

from app.services.chat.agent_sse import (
    AgentSSEStreamer,
    _content_preview,
    _parse_tool_output,
    _primary_query,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_sse_frame(frame: str) -> dict:
    assert frame.startswith("data: ")
    assert frame.endswith("\n\n")
    return json.loads(frame[len("data: ") : -2])


class _FakeAgent:
    """Mimics the slice of CompiledGraph used by AgentSSEStreamer."""

    def __init__(self, events: list[dict] | Exception) -> None:
        self._events = events

    async def astream_events(
        self,
        input_state: dict,
        *,
        config: dict,
        version: str,
    ) -> AsyncIterator[dict]:
        if isinstance(self._events, Exception):
            raise self._events
        for ev in self._events:
            yield ev


class _Chunk:
    """Mimics the AIMessageChunk passed through ``on_chat_model_stream``."""

    def __init__(self, content: str) -> None:
        self.content = content


# ---------------------------------------------------------------------------
# pure helpers
# ---------------------------------------------------------------------------


class TestContentPreview:
    def test_truncates_long_strings(self) -> None:
        text = "x" * 500
        out = _content_preview(text)
        assert out.endswith("...")
        assert len(out) == 200 + len("...")

    def test_short_string_unchanged(self) -> None:
        assert _content_preview("hi") == "hi"

    def test_none_yields_empty(self) -> None:
        assert _content_preview(None) == ""

    def test_dict_serialised_as_json(self) -> None:
        out = _content_preview({"k": "v"})
        assert "k" in out and "v" in out


class TestPrimaryQuery:
    def test_picks_query_first(self) -> None:
        assert _primary_query({"query": "Q1", "question": "Q2"}) == "Q1"

    def test_falls_back_through_aliases(self) -> None:
        assert _primary_query({"question": "Q1"}) == "Q1"
        assert _primary_query({"q": "Q2"}) == "Q2"
        assert _primary_query({"text": "Q3"}) == "Q3"

    def test_empty_args_returns_empty_string(self) -> None:
        assert _primary_query(None) == ""
        assert _primary_query({}) == ""

    def test_non_string_value_skipped(self) -> None:
        assert _primary_query({"query": 42, "question": "fallback"}) == "fallback"


class TestParseToolOutput:
    def test_dict_with_sources_field(self) -> None:
        sources, preview = _parse_tool_output(
            {"content": "x", "sources": [{"bvid": "BV1"}]}
        )
        assert sources == [{"bvid": "BV1"}]
        assert preview  # any truthy preview

    def test_dict_with_results_field(self) -> None:
        sources, _ = _parse_tool_output({"results": [{"bvid": "BV1"}]})
        assert sources == [{"bvid": "BV1"}]

    def test_json_string_parsed(self) -> None:
        payload = json.dumps({"sources": [{"bvid": "BV1"}]})
        sources, _ = _parse_tool_output(payload)
        assert sources == [{"bvid": "BV1"}]

    def test_invalid_json_string_yields_empty_sources(self) -> None:
        sources, preview = _parse_tool_output("not json")
        assert sources == []
        assert preview == "not json"

    def test_non_dict_in_sources_filtered(self) -> None:
        sources, _ = _parse_tool_output(
            {"sources": [{"bvid": "BV1"}, "garbage", 42]}
        )
        assert sources == [{"bvid": "BV1"}]


# ---------------------------------------------------------------------------
# AgentSSEStreamer.stream — full event translation
# ---------------------------------------------------------------------------


class TestStream:
    @pytest.mark.asyncio
    async def test_chunk_event_emits_chunk_frame(self) -> None:
        events = [
            {
                "event": "on_chat_model_stream",
                "data": {"chunk": _Chunk("你好")},
            }
        ]
        streamer = AgentSSEStreamer()

        frames = [f async for f in streamer.stream(_FakeAgent(events), {}, {})]

        chunk_frame = _parse_sse_frame(frames[0])
        assert chunk_frame == {"type": "chunk", "content": "你好"}
        assert streamer.full_content == "你好"

    @pytest.mark.asyncio
    async def test_empty_chunk_skipped(self) -> None:
        events = [
            {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("")}},
        ]
        frames = [
            f async for f in AgentSSEStreamer().stream(_FakeAgent(events), {}, {})
        ]

        # Only the trailing sources + done frames remain
        kinds = [_parse_sse_frame(f)["type"] for f in frames]
        assert kinds == ["sources", "done"]

    @pytest.mark.asyncio
    async def test_tool_lifecycle_emits_step_frames(self) -> None:
        events = [
            {
                "event": "on_tool_start",
                "run_id": "r1",
                "name": "vector_search",
                "data": {"input": {"query": "中国哲学"}},
            },
            {
                "event": "on_tool_end",
                "run_id": "r1",
                "name": "vector_search",
                "data": {"output": {"sources": [{"bvid": "BV1"}]}},
            },
        ]
        frames = [
            f async for f in AgentSSEStreamer().stream(_FakeAgent(events), {}, {})
        ]

        parsed = [_parse_sse_frame(f) for f in frames]
        kinds = [p["type"] for p in parsed]
        assert kinds == ["step", "step", "sources", "done"]

        start, end, sources_frame, done = parsed
        assert start["step"]["step"] == 1
        assert start["step"]["action"] == "vector_search"
        assert start["step"]["query"] == "中国哲学"

        assert end["step"]["step"] == 1
        assert end["step"]["action"] == "vector_search"
        assert end["step"]["sources"] == [{"bvid": "BV1"}]

        assert sources_frame["sources"] == [{"bvid": "BV1"}]
        assert done == {"type": "done"}

    @pytest.mark.asyncio
    async def test_two_tool_calls_dedup_sources(self) -> None:
        events = [
            {
                "event": "on_tool_start",
                "run_id": "r1",
                "name": "vector_search",
                "data": {"input": {"query": "Q1"}},
            },
            {
                "event": "on_tool_end",
                "run_id": "r1",
                "name": "vector_search",
                "data": {"output": {"sources": [{"bvid": "BV1"}]}},
            },
            {
                "event": "on_tool_start",
                "run_id": "r2",
                "name": "vector_search",
                "data": {"input": {"query": "Q2"}},
            },
            {
                "event": "on_tool_end",
                "run_id": "r2",
                "name": "vector_search",
                "data": {
                    "output": {
                        "sources": [{"bvid": "BV1"}, {"bvid": "BV2"}],
                    }
                },
            },
        ]
        streamer = AgentSSEStreamer()
        frames = [f async for f in streamer.stream(_FakeAgent(events), {}, {})]

        sources_frame = _parse_sse_frame(frames[-2])
        assert sources_frame["type"] == "sources"
        # BV1 emitted twice — must appear only once
        assert sources_frame["sources"] == [{"bvid": "BV1"}, {"bvid": "BV2"}]
        assert streamer._step_no == 2  # two tool runs counted

    @pytest.mark.asyncio
    async def test_step_numbers_increment(self) -> None:
        events = [
            {
                "event": "on_tool_start",
                "run_id": "r1",
                "name": "t1",
                "data": {"input": {"query": "a"}},
            },
            {
                "event": "on_tool_start",
                "run_id": "r2",
                "name": "t2",
                "data": {"input": {"query": "b"}},
            },
        ]
        frames = [
            f async for f in AgentSSEStreamer().stream(_FakeAgent(events), {}, {})
        ]
        steps = [
            _parse_sse_frame(f)["step"]["step"]
            for f in frames
            if _parse_sse_frame(f)["type"] == "step"
        ]
        assert steps == [1, 2]

    @pytest.mark.asyncio
    async def test_exception_yields_error_frame(self) -> None:
        agent = _FakeAgent(RuntimeError("explosion"))
        frames = [
            f async for f in AgentSSEStreamer().stream(agent, {}, {})
        ]

        # Should yield a single error frame, no done
        kinds = [_parse_sse_frame(f)["type"] for f in frames]
        assert "error" in kinds
        error_frame = next(_parse_sse_frame(f) for f in frames if '"error"' in f)
        assert "explosion" in error_frame["message"]

    @pytest.mark.asyncio
    async def test_unknown_event_kinds_ignored(self) -> None:
        events = [
            {"event": "on_chain_start", "data": {}},
            {"event": "on_random", "data": {}},
        ]
        frames = [
            f async for f in AgentSSEStreamer().stream(_FakeAgent(events), {}, {})
        ]
        kinds = [_parse_sse_frame(f)["type"] for f in frames]
        # Only the trailing sources + done frames survive
        assert kinds == ["sources", "done"]

    @pytest.mark.asyncio
    async def test_sources_capped_at_five(self) -> None:
        sources = [{"bvid": f"BV{i}"} for i in range(10)]
        events = [
            {
                "event": "on_tool_end",
                "run_id": "r1",
                "name": "vector_search",
                "data": {"output": {"sources": sources}},
            }
        ]
        streamer = AgentSSEStreamer()
        frames = [f async for f in streamer.stream(_FakeAgent(events), {}, {})]

        parsed = [_parse_sse_frame(f) for f in frames]
        sources_frame = next(p for p in parsed if p["type"] == "sources")
        assert len(sources_frame["sources"]) == 5
        # All 10 unique sources are accumulated internally; only the first
        # 5 hit the wire so the UI doesn't drown.
        assert len(streamer.sources) == 10
