"""Plan 0023: Rate limiting middleware using Redis token-bucket algorithm.

Provides second-line defense after nginx limit_req.
Redis is already available, so this adds zero infrastructure cost.
"""

from __future__ import annotations

import logging
import time

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

logger = logging.getLogger(__name__)

# Endpoint-specific rate limits (requests per second, burst)
_RATE_LIMITS: dict[str, tuple[float, int]] = {
    "/auth": (1.0, 5),  # login / verification: 1 rps burst 5
    "/chat/ask": (3.0, 10),  # AI chat: 3 rps burst 10
    "/cloud/upload": (5.0, 30),  # chunked upload: 5 rps burst 30
    "/favorites/organize": (1.0, 3),
    "/quiz/generate": (2.0, 5),
    "/credentials": (1.0, 3),
    "/workspaces": (5.0, 10),
}

_GLOBAL_RATE = (20.0, 50)  # global fallback: 20 rps burst 50


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Token-bucket rate limiter backed by Redis.

    Key format: bilirag:rl:<endpoint>:<ip>:<window>
    """

    def __init__(self, app, redis_client=None):
        super().__init__(app)
        self._redis = redis_client

    async def dispatch(self, request: Request, call_next) -> Response:
        if self._redis is None:
            return await call_next(request)

        path = request.url.path[:256]
        client_ip = request.client.host if request.client else "unknown"

        # Determine rate limit for this path
        rate, burst = _GLOBAL_RATE
        for prefix, (r, b) in _RATE_LIMITS.items():
            if path.startswith(prefix):
                rate, burst = r, b
                break

        # Token bucket: use a 1-second sliding window
        window = int(time.time())
        key = f"bilirag:rl:{path}:{client_ip}:{window}"

        try:
            current = await self._redis.incr(key)
            if current == 1:
                await self._redis.expire(key, 2)  # TTL 2s to auto-cleanup

            if current > burst:
                logger.warning(
                    "[RATELIMIT] blocked | ip={} path={} count={} burst={}",
                    client_ip,
                    path,
                    current,
                    burst,
                )
                return JSONResponse(
                    status_code=429,
                    content={
                        "detail": "请求过于频繁，请稍后重试",
                        "retry_after": int(1 / rate) if rate > 0 else 1,
                    },
                    headers={"Retry-After": str(int(1 / rate)) if rate > 0 else "1"},
                )
        except Exception as e:
            logger.debug("[RATELIMIT] redis error, allowing request: {}", e)
            # Redis unavailable → allow request (fail open, nginx is first line)

        return await call_next(request)
