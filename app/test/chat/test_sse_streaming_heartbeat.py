"""Tests for the shared SSE response wrapper (app/routers/streaming.py).

The heartbeat layer is the guard against the "silent death" failure mode: a
source generator that produces nothing for longer than a gateway's idle read
timeout (nginx / APISIX both 300s on /chat) used to get its stream cut with
no error frame. Comment frames (``: ping``) keep every hop's idle timer
reset and are ignored by all client parsers.
"""

from __future__ import annotations

import asyncio
from typing import AsyncIterator

import pytest

from app.routers.streaming import _with_heartbeat, sse_streaming_response


async def _delayed_source(frames: list[str], delay: float) -> AsyncIterator[str]:
    for frame in frames:
        await asyncio.sleep(delay)
        yield frame


class TestHeartbeat:
    @pytest.mark.asyncio
    async def test_ping_emitted_while_source_silent(self) -> None:
        # Source takes 0.2s per frame; timer fires every 0.05s → pings in
        # between real frames.
        out = [
            f
            async for f in _with_heartbeat(
                _delayed_source(["data: a\n\n", "data: b\n\n"], 0.2), interval=0.05
            )
        ]
        pings = [f for f in out if f == ": ping\n\n"]
        assert len(pings) >= 2
        # Real frames pass through in order, after at least one ping each.
        real = [f for f in out if f != ": ping\n\n"]
        assert real == ["data: a\n\n", "data: b\n\n"]
        assert out.index(": ping\n\n") < out.index("data: a\n\n")

    @pytest.mark.asyncio
    async def test_fast_source_no_pings(self) -> None:
        out = [
            f
            async for f in _with_heartbeat(
                _delayed_source(["data: a\n\n", "data: b\n\n"], 0.001), interval=0.5
            )
        ]
        assert out == ["data: a\n\n", "data: b\n\n"]

    @pytest.mark.asyncio
    async def test_source_exception_propagates(self) -> None:
        async def boom() -> AsyncIterator[str]:
            yield "data: a\n\n"
            raise RuntimeError("explosion")

        with pytest.raises(RuntimeError):
            async for _ in _with_heartbeat(boom(), interval=0.05):
                pass

    @pytest.mark.asyncio
    async def test_source_never_yields_pings_forever_until_cancelled(self) -> None:
        # A wedged source (never yields, never ends) keeps the heartbeat
        # alive — the stream no longer dies silently; consuming stops when
        # the client disconnects (generator close → finally in wrapper).
        async def wedged() -> AsyncIterator[str]:
            await asyncio.sleep(3600)
            yield "data: x\n\n"  # pragma: no cover

        agen = _with_heartbeat(wedged(), interval=0.05)
        first = await agen.__anext__()
        assert first == ": ping\n\n"
        await agen.aclose()  # must close cleanly (pending task cancelled)


def test_response_uses_heartbeat_wrapper() -> None:
    async def gen() -> AsyncIterator[str]:
        yield "data: done\n\n"

    resp = sse_streaming_response(gen())
    assert resp.media_type == "text/event-stream"
    assert resp.headers["x-accel-buffering"] == "no"
