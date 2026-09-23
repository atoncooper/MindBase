"""Shared SSE streaming-response helpers for routers.

Every SSE endpoint must go through ``sse_streaming_response`` so gateway
proxies (nginx / APISIX) stream tokens incrementally instead of collapsing
the stream into one bulk delivery:

- ``X-Accel-Buffering: no`` — nginx and APISIX both honor it per-response,
  disabling proxy buffering even when buffering is on at the http/location
  level.
- ``Cache-Control: no-cache`` — keeps intermediate cache layers from holding
  the response.
- Heartbeat — SSE comment frames (``: ping``) are emitted whenever the
  upstream generator stays silent longer than ``_HEARTBEAT_INTERVAL`` (LLM
  thinking, long tool calls). SSE comments are ignored by every client
  parser (they don't start with ``data: ``) but reset idle-read timers on
  every proxy hop, so a silent stretch can never outlive a gateway read
  timeout and clients get a liveness signal instead of a frozen panel.

Note: ``Connection: keep-alive`` is deliberately NOT set — it is a hop-by-hop
header managed by the server/proxies (stripped by nginx, invalid on HTTP/2).
"""

import asyncio
from collections.abc import AsyncIterator

from fastapi.responses import StreamingResponse

SSE_HEADERS = {
    "X-Accel-Buffering": "no",
    "Cache-Control": "no-cache",
}

# Must stay below every hop's idle read timeout (nginx 300s, APISIX 300s)
# with a wide margin.
_HEARTBEAT_INTERVAL = 15.0


async def _with_heartbeat(
    source: AsyncIterator[str],
    interval: float = _HEARTBEAT_INTERVAL,
) -> AsyncIterator[str]:
    """Forward ``source`` frames, emitting ``: ping`` while it is silent.

    ``anext(source)`` runs as a task raced against the timer. On timeout the
    task is NOT cancelled — the frame stays pending and the next iteration
    waits on the same task again, so a slow-but-alive source is never
    interrupted mid-frame (cancelling an in-flight ``__anext__`` would kill
    the underlying generator). Exceptions raised by the source propagate to
    the consumer unchanged.
    """
    pending = asyncio.ensure_future(anext(source))
    try:
        while True:
            done, _ = await asyncio.wait({pending}, timeout=interval)
            if not done:
                yield ": ping\n\n"
                continue
            try:
                frame = pending.result()
            except StopAsyncIteration:
                return
            yield frame
            pending = asyncio.ensure_future(anext(source))
    finally:
        pending.cancel()
        try:
            await pending
        except BaseException:
            pass


def sse_streaming_response(generator: AsyncIterator[str]) -> StreamingResponse:
    """Build an SSE StreamingResponse with anti-buffering headers + heartbeat."""
    return StreamingResponse(
        _with_heartbeat(generator),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )
