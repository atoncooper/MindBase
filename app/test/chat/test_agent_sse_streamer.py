"""Unit tests for AgentSSEStreamer (app/services/chat/agent_sse.py).

The streamer translates ``CompiledGraph.astream_events(version="v2")``
into the SSE protocol the frontend speaks. The non-trivial
responsibilities covered here:

1. Step frames derived from ``on_chat_model_end`` (tool calls the LLM
   decided on) and completed at node boundaries (ToolMessages returned
   by ``runtime_dispatch``) — AgentRuntime invokes tools via direct
   ``tool.run()``, so no ``on_tool_*`` events ever fire.
2. Reasoning deltas (``reasoning_content``) streamed as dedicated
   ``reasoning`` frames without polluting the answer text.
3. Reset/replay between LLM runs: a retry after a mid-stream failure
   discards the failed run's partial text but replays earlier preambles;
   a normal continuation after tools just appends.
4. The silent-fallback fix: a graph that completes with ``error`` in its
   final state surfaces the fallback text as an ``error`` frame instead
   of ending the stream as if the answer were done.
5. Parsing tool outputs (string JSON or dict) to extract ``sources``.
"""

from __future__ import annotations

import json
from typing import AsyncIterator

import pytest

from langchain_core.messages import AIMessage, ToolMessage

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


def _parse_frames(frames: list[str]) -> list[dict]:
    return [_parse_sse_frame(f) for f in frames]


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

    def __init__(self, content: str, reasoning: str | None = None) -> None:
        self.content = content
        self.additional_kwargs = (
            {"reasoning_content": reasoning} if reasoning else {}
        )


def _model_end(tool_call_id: str, name: str, args: dict) -> dict:
    """An ``on_chat_model_end`` event whose output requests one tool call."""
    return {
        "event": "on_chat_model_end",
        "data": {
            "output": AIMessage(
                content="",
                tool_calls=[{"id": tool_call_id, "name": name, "args": args}],
            )
        },
    }


def _node_end(tool_call_id: str, name: str, **extras) -> dict:
    """A node-boundary ``on_chain_end`` carrying one ToolMessage result."""
    return {
        "event": "on_chain_end",
        "name": "runtime_dispatch",
        "data": {
            "output": {
                "messages": [
                    ToolMessage(
                        content="ok",
                        tool_call_id=tool_call_id,
                        name=name,
                        additional_kwargs=extras,
                    )
                ]
            }
        },
    }


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
        sources, preview, _ = _parse_tool_output(
            {"content": "x", "sources": [{"bvid": "BV1"}]}
        )
        assert sources == [{"bvid": "BV1"}]
        assert preview  # any truthy preview

    def test_dict_with_results_field(self) -> None:
        sources, _, _ = _parse_tool_output({"results": [{"bvid": "BV1"}]})
        assert sources == [{"bvid": "BV1"}]

    def test_json_string_parsed(self) -> None:
        payload = json.dumps({"sources": [{"bvid": "BV1"}]})
        sources, _, _ = _parse_tool_output(payload)
        assert sources == [{"bvid": "BV1"}]

    def test_invalid_json_string_yields_empty_sources(self) -> None:
        sources, preview, _ = _parse_tool_output("not json")
        assert sources == []
        assert preview == "not json"

    def test_non_dict_in_sources_filtered(self) -> None:
        sources, _, _ = _parse_tool_output(
            {"sources": [{"bvid": "BV1"}, "garbage", 42]}
        )
        assert sources == [{"bvid": "BV1"}]

    def test_failed_delegate_with_empty_sub_steps_does_not_crash(self) -> None:
        # Regression: a delegate_to_agent ToolMessage with empty sub_steps
        # (e.g. a failed delegation) previously crashed _parse_tool_output
        # because the fallthrough passed the raw ToolMessage to
        # _content_preview -> json.dumps(ToolMessage) -> TypeError, which
        # aborted the whole SSE stream.
        failed_tm = ToolMessage(
            content="委托失败: ",
            tool_call_id="c1",
            name="delegate_to_agent",
            additional_kwargs={"sub_steps": [], "failed": True},
        )
        # Must not raise.
        srcs, _preview, arts = _parse_tool_output(failed_tm)
        assert srcs == []
        assert arts == []


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

        # Only the trailing sources + error + done frames remain (empty
        # answer now surfaces an error instead of a silent done).
        kinds = [_parse_sse_frame(f)["type"] for f in frames]
        assert kinds == ["sources", "error", "done"]

    @pytest.mark.asyncio
    async def test_tool_lifecycle_emits_step_frames(self) -> None:
        # Tool starts derive from on_chat_model_end (the LLM's decision) and
        # complete at the node boundary that returns the ToolMessage.
        events = [
            _model_end("c1", "vector_search", {"query": "中国哲学"}),
            _node_end("c1", "vector_search", sources=[{"bvid": "BV1"}]),
        ]
        streamer = AgentSSEStreamer()
        frames = [f async for f in streamer.stream(_FakeAgent(events), {}, {})]

        parsed = _parse_frames(frames)
        steps = [p for p in parsed if p["type"] == "step"]
        assert len(steps) == 2

        start, end = steps
        assert start["step"]["step"] == 1
        assert start["step"]["action"] == "vector_search"
        assert start["step"]["query"] == "中国哲学"
        assert start["step"]["content_preview"] == ""

        assert end["step"]["step"] == 1  # completion updates the same step
        assert end["step"]["sources"] == [{"bvid": "BV1"}]
        assert end["step"]["content_preview"] == "ok"

        sources_frame = next(p for p in parsed if p["type"] == "sources")
        assert sources_frame["sources"] == [{"bvid": "BV1"}]

    @pytest.mark.asyncio
    async def test_two_tool_calls_dedup_sources(self) -> None:
        events = [
            _model_end("c1", "vector_search", {"query": "Q1"}),
            _node_end("c1", "vector_search", sources=[{"bvid": "BV1"}]),
            _model_end("c2", "vector_search", {"query": "Q2"}),
            _node_end("c2", "vector_search", sources=[{"bvid": "BV1"}, {"bvid": "BV2"}]),
        ]
        streamer = AgentSSEStreamer()
        frames = [f async for f in streamer.stream(_FakeAgent(events), {}, {})]

        parsed = _parse_frames(frames)
        sources_frame = next(p for p in parsed if p["type"] == "sources")
        # BV1 emitted twice — must appear only once
        assert sources_frame["sources"] == [{"bvid": "BV1"}, {"bvid": "BV2"}]
        assert streamer._step_no == 2  # two tool runs counted

    @pytest.mark.asyncio
    async def test_parallel_tool_calls_get_separate_steps(self) -> None:
        # One model turn requesting two tools → two start steps; both
        # completions arrive at the same node boundary.
        output = AIMessage(
            content="",
            tool_calls=[
                {"id": "c1", "name": "t1", "args": {"query": "a"}},
                {"id": "c2", "name": "t2", "args": {"query": "b"}},
            ],
        )
        events = [
            {"event": "on_chat_model_end", "data": {"output": output}},
            {
                "event": "on_chain_end",
                "name": "runtime_dispatch",
                "data": {
                    "output": {
                        "messages": [
                            ToolMessage(content="r1", tool_call_id="c1", name="t1"),
                            ToolMessage(content="r2", tool_call_id="c2", name="t2"),
                        ]
                    }
                },
            },
        ]
        frames = [f async for f in AgentSSEStreamer().stream(_FakeAgent(events), {}, {})]
        parsed = _parse_frames(frames)
        steps = [p for p in parsed if p["type"] == "step"]
        # Both start frames emit at model_end, both completions at the node
        # boundary — grouped as starts [1, 2] then completions [1, 2].
        assert [s["step"]["step"] for s in steps] == [1, 2, 1, 2]
        assert [s["step"]["action"] for s in steps] == ["t1", "t2", "t1", "t2"]

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
        # Only the trailing sources + error + done frames survive (unknown
        # events ignored AND no content streamed → empty-answer error).
        assert kinds == ["sources", "error", "done"]

    @pytest.mark.asyncio
    async def test_sources_capped_at_five(self) -> None:
        sources = [{"bvid": f"BV{i}"} for i in range(10)]
        events = [
            _model_end("c1", "vector_search", {"query": "q"}),
            _node_end("c1", "vector_search", sources=sources),
        ]
        streamer = AgentSSEStreamer()
        frames = [f async for f in streamer.stream(_FakeAgent(events), {}, {})]

        parsed = _parse_frames(frames)
        sources_frame = next(p for p in parsed if p["type"] == "sources")
        assert len(sources_frame["sources"]) == 5
        # All 10 unique sources are accumulated internally; only the first
        # 5 hit the wire so the UI doesn't drown.
        assert len(streamer.sources) == 10


# ---------------------------------------------------------------------------
# reasoning streaming
# ---------------------------------------------------------------------------


class TestReasoning:
    @pytest.mark.asyncio
    async def test_reasoning_delta_emits_reasoning_frame(self) -> None:
        events = [
            {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("", "正在分析板子")}},
            {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("答案")}},
        ]
        streamer = AgentSSEStreamer()
        frames = [f async for f in streamer.stream(_FakeAgent(events), {}, {})]

        parsed = _parse_frames(frames)
        reasoning_frames = [p for p in parsed if p["type"] == "reasoning"]
        assert reasoning_frames == [{"type": "reasoning", "content": "正在分析板子"}]
        # Reasoning never leaks into the answer text.
        assert streamer.full_content == "答案"
        assert streamer.reasoning_content == "正在分析板子"
        assert [p["type"] for p in parsed] == ["reasoning", "chunk", "sources", "done"]

    @pytest.mark.asyncio
    async def test_reasoning_and_content_in_one_chunk(self) -> None:
        events = [
            {
                "event": "on_chat_model_stream",
                "data": {"chunk": _Chunk("答", "想")},
            }
        ]
        parsed = _parse_frames(
            [f async for f in AgentSSEStreamer().stream(_FakeAgent(events), {}, {})]
        )
        kinds = [p["type"] for p in parsed]
        assert kinds[:2] == ["reasoning", "chunk"]


# ---------------------------------------------------------------------------
# reset / replay between LLM runs
# ---------------------------------------------------------------------------


class TestModelStartBookkeeping:
    @pytest.mark.asyncio
    async def test_continuation_after_tools_appends_without_reset(self) -> None:
        # LLM streams a preamble, calls a tool, the tool completes, the LLM
        # runs again: no reset — the preamble stays and a blank line
        # separates the segments.
        events = [
            {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("我先看下板子")}},
            _model_end("c1", "board_get", {"board_uuid": "u1"}),
            _node_end("c1", "board_get"),
            {"event": "on_chat_model_start", "data": {}},
            {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("结论如下")}},
        ]
        streamer = AgentSSEStreamer()
        frames = [f async for f in streamer.stream(_FakeAgent(events), {}, {})]

        parsed = _parse_frames(frames)
        kinds = [p["type"] for p in parsed]
        assert "reset" not in kinds
        assert streamer.full_content == "我先看下板子\n\n结论如下"
        chunk_frames = [p for p in parsed if p["type"] == "chunk"]
        assert [c["content"] for c in chunk_frames] == ["我先看下板子", "\n\n", "结论如下"]

    @pytest.mark.asyncio
    async def test_retry_after_midstream_failure_resets_and_replays(self) -> None:
        # Run 1 streams partial text then dies (no on_chat_model_end); the
        # retry must emit reset and replay the pre-run content.
        events = [
            {"event": "on_chat_model_start", "data": {}},  # run 1 begins
            {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("前半")}},
            {"event": "on_chat_model_start", "data": {}},  # retry begins
            {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("完整答案")}},
        ]
        streamer = AgentSSEStreamer()
        frames = [f async for f in streamer.stream(_FakeAgent(events), {}, {})]

        parsed = _parse_frames(frames)
        kinds = [p["type"] for p in parsed]
        assert kinds == ["chunk", "reset", "chunk", "sources", "done"]
        # The failed run's partial text is discarded server-side too.
        assert streamer.full_content == "完整答案"
        # The reset is followed by a replay of the pre-run content (empty
        # here, so no replay chunk).
        assert [p["content"] for p in parsed if p["type"] == "chunk"] == ["前半", "完整答案"]

    @pytest.mark.asyncio
    async def test_retry_keeps_preamble_from_earlier_completed_run(self) -> None:
        # Run 1 streamed a preamble + tool call (completed), tool ran, run 2
        # errored mid-stream, run 3 retries: reset must restore run 1's
        # preamble, not wipe it.
        events = [
            {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("前言")}},
            _model_end("c1", "board_update", {"board_uuid": "u1"}),
            _node_end("c1", "board_update"),
            {"event": "on_chat_model_start", "data": {}},  # run 2 begins
            {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("半截")}},
            {"event": "on_chat_model_start", "data": {}},  # retry (run 3)
            {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("答案")}},
        ]
        streamer = AgentSSEStreamer()
        frames = [f async for f in streamer.stream(_FakeAgent(events), {}, {})]

        parsed = _parse_frames(frames)
        assert "reset" in [p["type"] for p in parsed]
        # Server-side content keeps the preamble + the successful answer.
        assert streamer.full_content == "前言\n\n答案"
        # The retry emitted a replay chunk carrying the preamble.
        resets = [i for i, p in enumerate(parsed) if p["type"] == "reset"]
        assert len(resets) == 1
        replay = parsed[resets[0] + 1]
        assert replay == {"type": "chunk", "content": "前言\n\n"}


# ---------------------------------------------------------------------------
# silent-fallback fix
# ---------------------------------------------------------------------------


class TestGraphErrorFallback:
    @pytest.mark.asyncio
    async def test_final_state_error_emits_error_frame(self) -> None:
        # error_node exhausted retries: the graph completes normally with
        # ``error`` + fallback ``result`` in its final state. The client
        # must receive an error frame (previously the stream just ended).
        events = [
            {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("我先看下")}},
            {
                "event": "on_chain_end",
                "name": "root",
                "data": {
                    "output": {
                        "messages": [AIMessage(content="我先看下")],
                        "error": "gateway timeout",
                        "result": "板子服务暂时不可用，请稍后再试。",
                    }
                },
            },
        ]
        streamer = AgentSSEStreamer()
        frames = [f async for f in streamer.stream(_FakeAgent(events), {}, {"run_name": "root"})]

        parsed = _parse_frames(frames)
        kinds = [p["type"] for p in parsed]
        assert kinds == ["chunk", "sources", "error", "done"]
        error_frame = next(p for p in parsed if p["type"] == "error")
        assert error_frame["message"] == "板子服务暂时不可用，请稍后再试。"
        assert streamer.had_error is True
        assert streamer.error_message == "板子服务暂时不可用，请稍后再试。"

    @pytest.mark.asyncio
    async def test_final_state_error_without_result_uses_generic_message(self) -> None:
        events = [
            {
                "event": "on_chain_end",
                "name": "root",
                "data": {"output": {"messages": [], "error": "circuit breaker open"}},
            },
        ]
        frames = [f async for f in AgentSSEStreamer().stream(_FakeAgent(events), {}, {"run_name": "root"})]
        parsed = _parse_frames(frames)
        error_frame = next(p for p in parsed if p["type"] == "error")
        assert "Agent 执行失败" in error_frame["message"]

    @pytest.mark.asyncio
    async def test_retry_cleared_error_does_not_trigger_fallback(self) -> None:
        # A mid-run retry clears ``error`` to "" before the graph ends —
        # only a final-state error counts. Content streams normally, so no
        # error frame of any kind (fallback OR empty-answer) may appear.
        events = [
            {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("ok")}},
            {
                "event": "on_chain_end",
                "name": "root",
                "data": {"output": {"messages": [AIMessage(content="ok")], "error": ""}},
            },
        ]
        parsed = _parse_frames(
            [f async for f in AgentSSEStreamer().stream(_FakeAgent(events), {}, {"run_name": "root"})]
        )
        assert not any(p["type"] == "error" for p in parsed)


class TestEmptyAnswer:
    """A graph that completes "successfully" with no answer text (model
    emitted only reasoning) must surface an error frame instead of a silent
    done that persists an empty reply into history."""

    @pytest.mark.asyncio
    async def test_empty_content_yields_error_frame(self) -> None:
        events = [
            {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("", "只想不说")}},
        ]
        parsed = _parse_frames(
            [f async for f in AgentSSEStreamer().stream(_FakeAgent(events), {}, {})]
        )
        kinds = [p["type"] for p in parsed]
        assert kinds == ["reasoning", "sources", "error", "done"]
        error_frame = next(p for p in parsed if p["type"] == "error")
        assert "模型未返回有效内容" in error_frame["message"]
        assert next(p for p in parsed if p["type"] == "done")  # done still sent

    @pytest.mark.asyncio
    async def test_whitespace_only_content_counts_as_empty(self) -> None:
        events = [
            {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("  \n ")}},
        ]
        parsed = _parse_frames(
            [f async for f in AgentSSEStreamer().stream(_FakeAgent(events), {}, {})]
        )
        assert any(p["type"] == "error" for p in parsed)

    @pytest.mark.asyncio
    async def test_graph_error_takes_precedence_over_empty_check(self) -> None:
        # A fallback result carries text, so the empty-answer branch must not
        # overwrite the more specific fallback error message.
        events = [
            {
                "event": "on_chain_end",
                "name": "root",
                "data": {"output": {"messages": [], "error": "boom", "result": ""}},
            },
        ]
        parsed = _parse_frames(
            [f async for f in AgentSSEStreamer().stream(_FakeAgent(events), {}, {"run_name": "root"})]
        )
        error_frame = next(p for p in parsed if p["type"] == "error")
        assert "Agent 执行失败" in error_frame["message"]


class TestCaptureRootOutputArtifacts:
    """Recover sources + artifacts from the final state.

    AgentRuntime.execute() calls tool.run() directly (no LangChain
    callbacks), so on_tool_* events never fire. The streamer must instead
    recover structured outputs from the final state's ToolMessages -
    including artifacts nested in a delegated sub-agent's sub_steps (e.g.
    code agent's run_code).
    """

    @pytest.mark.asyncio
    async def test_artifact_recovered_from_delegated_sub_steps(self) -> None:
        artifact = {
            "name": "heart.png",
            "url": "https://minio/heart.png",
            "minio_key": "code-artifacts/1/abc/heart.png",
            "content_type": "image/png",
            "size": 29924,
        }
        tool_msg = ToolMessage(
            content="done",
            tool_call_id="tc1",
            name="delegate_to_agent",
            additional_kwargs={
                "sub_steps": [
                    {"action": "run_code", "artifacts": [artifact]},
                ],
            },
        )
        events = [
            {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("ok")}},
            {
                "event": "on_chain_end",
                "name": "root",
                "data": {"output": {"messages": [AIMessage(content="ok"), tool_msg]}},
            },
        ]
        streamer = AgentSSEStreamer()
        frames = [
            f async for f in streamer.stream(_FakeAgent(events), {}, {"run_name": "root"})
        ]

        parsed = _parse_frames(frames)
        art_frames = [p for p in parsed if p["type"] == "artifact"]
        assert len(art_frames) == 1
        assert art_frames[0]["artifact"]["url"] == "https://minio/heart.png"
        assert art_frames[0]["artifact"]["name"] == "heart.png"
        # Artifacts flushed before sources/done.
        kinds = [p["type"] for p in parsed]
        assert kinds.index("artifact") < kinds.index("sources")
        assert kinds.index("artifact") < kinds.index("done")

    @pytest.mark.asyncio
    async def test_no_artifact_no_artifact_frame(self) -> None:
        # A normal turn with no code artifacts emits no artifact frame.
        events = [
            {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("hi")}},
            {
                "event": "on_chain_end",
                "name": "root",
                "data": {"output": {"messages": [AIMessage(content="hi")]}},
            },
        ]
        frames = [
            f async for f in AgentSSEStreamer().stream(
                _FakeAgent(events), {}, {"run_name": "root"}
            )
        ]
        kinds = [_parse_sse_frame(f)["type"] for f in frames]
        assert "artifact" not in kinds

    @pytest.mark.asyncio
    async def test_mixed_failed_and_successful_delegate_recovers_artifact(self) -> None:
        # A failed delegate (empty sub_steps) alongside a successful one must
        # not abort artifact recovery from the successful one, and the stream
        # must complete normally (done frame, no error frame).
        artifact = {
            "name": "forest.png",
            "url": "https://minio/forest.png",
            "minio_key": "k/forest.png",
            "content_type": "image/png",
            "size": 59379,
        }
        failed_tm = ToolMessage(
            content="委托失败: ",
            tool_call_id="c1",
            name="delegate_to_agent",
            additional_kwargs={"sub_steps": [], "failed": True},
        )
        ok_tm = ToolMessage(
            content="done",
            tool_call_id="c2",
            name="delegate_to_agent",
            additional_kwargs={
                "sub_steps": [{"action": "run_code", "artifacts": [artifact]}],
            },
        )
        events = [
            {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("ok")}},
            {
                "event": "on_chain_end",
                "name": "root",
                "data": {
                    "output": {"messages": [AIMessage(content="ok"), failed_tm, ok_tm]}
                },
            },
        ]
        streamer = AgentSSEStreamer()
        frames = [
            f async for f in streamer.stream(_FakeAgent(events), {}, {"run_name": "root"})
        ]
        parsed = _parse_frames(frames)
        art = [p for p in parsed if p["type"] == "artifact"]
        assert len(art) == 1
        assert art[0]["artifact"]["name"] == "forest.png"
        assert any(p["type"] == "done" for p in parsed)
        assert not any(p["type"] == "error" for p in parsed)
