"""Regression: a board agent turn whose LLM call fails must deliver the
fallback text as an ``error`` frame.

The bug this guards against: ``error_node`` sets ``error`` + fallback
``result`` in the state, but the terminal ``format_result`` node's
``as_error_node`` wrapper used to ``setdefault("error", "")`` — wiping the
error from the final state. The streamer then saw a "successful" graph with
an empty stream and either ended silently or (worse) mislabeled the fallback
as an empty answer. Uses the REAL board graph — synthetic root events in
test_agent_sse_streamer.py cannot catch state-shape bugs like this.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.agent.board.graph import build_board_agent
from app.services.chat.agent_sse import AgentSSEStreamer


class FailingLLM:
    """bind_tools-compatible LLM whose every call fails."""

    def bind_tools(self, tools: Any) -> "FailingLLM":
        return self

    async def ainvoke(self, messages: Any, config: Any = None) -> Any:
        raise RuntimeError("no healthy upstream")


class FakeRuntime:
    def list_tool_defs(self, names: Any = None) -> list:
        return []

    async def execute(self, tool_calls: Any, config: Any = None) -> list:
        return []


def _parse_sse_frame(frame: str) -> dict:
    assert frame.startswith("data: ") and frame.endswith("\n\n")
    return json.loads(frame[len("data: ") : -2])


@pytest.mark.asyncio
async def test_llm_failure_delivers_fallback_error_frame() -> None:
    graph = build_board_agent(FakeRuntime(), FailingLLM(), deps=None)
    run_config = {
        "recursion_limit": 30,
        "run_name": "board_agent_stream",
        "tags": ["board_agent", "streaming"],
        "metadata": {"agent_name": "board", "session_id": "s", "uid": 1},
    }
    input_state = {
        "query": "完善定义",
        "session_id": "",
        "uid": 1,
        "board_uuid": "u",
        "board_anchor_text": "连续的定义",
    }

    streamer = AgentSSEStreamer()
    frames = [
        _parse_sse_frame(f)
        async for f in streamer.stream(graph, input_state, run_config)
    ]

    error_frame = next(p for p in frames if p["type"] == "error")
    assert "本次请求未能完成" in error_frame["message"]
    assert streamer.had_error is True
    assert streamer.error_message == error_frame["message"]
    assert any(p["type"] == "done" for p in frames)


@pytest.mark.asyncio
async def test_fallback_state_keeps_error() -> None:
    """The terminal node must not wipe ``error`` from the final state —
    orchestrator._normalize_agent_result (non-streaming /ask) relies on it."""
    graph = build_board_agent(FakeRuntime(), FailingLLM(), deps=None)
    final = await graph.ainvoke(
        {
            "query": "完善定义",
            "session_id": "",
            "uid": 1,
            "board_uuid": "u",
            "board_anchor_text": "",
        },
        config={"recursion_limit": 30},
    )
    assert final["error"] == "no healthy upstream"
    assert "本次请求未能完成" in final["result"]
