"""Shared SSE streaming-response helpers for routers.

Every SSE endpoint must go through ``sse_streaming_response`` so gateway
proxies (nginx / APISIX) stream tokens incrementally instead of collapsing
the stream into one bulk delivery:

- ``X-Accel-Buffering: no`` — nginx and APISIX both honor it per-response,
  disabling proxy buffering even when buffering is on at the http/location
  level.
- ``Cache-Control: no-cache`` — keeps intermediate cache layers from holding
  the response.

Note: ``Connection: keep-alive`` is deliberately NOT set — it is a hop-by-hop
header managed by the server/proxies (stripped by nginx, invalid on HTTP/2).
"""

from collections.abc import AsyncIterator

from fastapi.responses import StreamingResponse

SSE_HEADERS = {
    "X-Accel-Buffering": "no",
    "Cache-Control": "no-cache",
}


def sse_streaming_response(generator: AsyncIterator[str]) -> StreamingResponse:
    """Build an SSE StreamingResponse with the anti-buffering headers."""
    return StreamingResponse(
        generator,
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )
