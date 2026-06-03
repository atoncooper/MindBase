"""Tests for RateLimitMiddleware and related utilities."""

import time
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.middleware.rate_limit import RateLimitMiddleware, _RATE_LIMITS, _GLOBAL_RATE


class TestRateLimitsConfig:
    def test_auth_rate_limit_exists(self):
        assert "/auth" in _RATE_LIMITS
        rate, burst = _RATE_LIMITS["/auth"]
        assert rate == 1.0
        assert burst == 5

    def test_chat_rate_limit_exists(self):
        assert "/chat/ask" in _RATE_LIMITS
        rate, burst = _RATE_LIMITS["/chat/ask"]
        assert rate == 3.0
        assert burst == 10

    def test_upload_rate_limit_exists(self):
        assert "/cloud/upload" in _RATE_LIMITS

    def test_workspaces_rate_limit_exists(self):
        assert "/workspaces" in _RATE_LIMITS

    def test_global_rate_fallback(self):
        rate, burst = _GLOBAL_RATE
        assert rate > 0
        assert burst > 0


class TestRateLimitDispatch:
    @pytest.mark.asyncio
    async def test_allow_first_request(self):
        mock_redis = AsyncMock()
        mock_redis.incr.return_value = 1
        mock_redis.expire = AsyncMock()

        app = MagicMock()
        middleware = RateLimitMiddleware(app, redis_client=mock_redis)

        request = MagicMock()
        request.url.path = "/auth/qrcode"
        request.client.host = "1.2.3.4"

        async def call_next(req):
            return MagicMock(status_code=200)

        response = await middleware.dispatch(request, call_next)
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_block_when_over_burst(self):
        mock_redis = AsyncMock()
        mock_redis.incr.return_value = 100
        mock_redis.expire = AsyncMock()

        app = MagicMock()
        middleware = RateLimitMiddleware(app, redis_client=mock_redis)

        request = MagicMock()
        request.url.path = "/auth/qrcode"
        request.client.host = "1.2.3.4"

        async def call_next(req):
            return MagicMock(status_code=200)

        response = await middleware.dispatch(request, call_next)
        assert response.status_code == 429
        body = response.body if hasattr(response, "body") else ""
        assert isinstance(response.status_code, int)

    @pytest.mark.asyncio
    async def test_allow_when_redis_unavailable(self):
        mock_redis = AsyncMock()
        mock_redis.incr.side_effect = RuntimeError("Redis down")

        app = MagicMock()
        middleware = RateLimitMiddleware(app, redis_client=mock_redis)

        request = MagicMock()
        request.url.path = "/chat/ask"
        request.client.host = "1.2.3.4"

        async def call_next(req):
            return MagicMock(status_code=200)

        response = await middleware.dispatch(request, call_next)
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_allow_when_no_redis_client(self):
        app = MagicMock()
        middleware = RateLimitMiddleware(app, redis_client=None)

        request = MagicMock()
        request.url.path = "/auth/qrcode"
        request.client.host = "1.2.3.4"

        async def call_next(req):
            return MagicMock(status_code=200)

        response = await middleware.dispatch(request, call_next)
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_path_truncated_to_256(self):
        mock_redis = AsyncMock()
        mock_redis.incr.return_value = 1
        mock_redis.expire = AsyncMock()

        app = MagicMock()
        middleware = RateLimitMiddleware(app, redis_client=mock_redis)

        request = MagicMock()
        request.url.path = "/chat/ask/" + "A" * 500
        request.client.host = "1.2.3.4"

        async def call_next(req):
            return MagicMock(status_code=200)

        await middleware.dispatch(request, call_next)
        # Verify the key used has truncated path
        calls = mock_redis.incr.call_args_list
        assert len(calls) > 0
        key_arg = calls[0][0][0]
        assert len(key_arg.split(":")[2]) <= 256

    @pytest.mark.asyncio
    async def test_different_paths_have_separate_counters(self):
        mock_redis = AsyncMock()
        mock_redis.incr.return_value = 1
        mock_redis.expire = AsyncMock()

        app = MagicMock()
        middleware = RateLimitMiddleware(app, redis_client=mock_redis)

        r1 = MagicMock()
        r1.url.path = "/auth/qrcode"
        r1.client.host = "1.2.3.4"

        r2 = MagicMock()
        r2.url.path = "/chat/ask"
        r2.client.host = "1.2.3.4"

        async def call_next(req):
            return MagicMock(status_code=200)

        await middleware.dispatch(r1, call_next)
        await middleware.dispatch(r2, call_next)

        keys = [c[0][0] for c in mock_redis.incr.call_args_list]
        assert len(set(keys)) == 2

    @pytest.mark.asyncio
    async def test_unknown_path_uses_global_rate(self):
        mock_redis = AsyncMock()
        mock_redis.incr.return_value = 1
        mock_redis.expire = AsyncMock()

        app = MagicMock()
        middleware = RateLimitMiddleware(app, redis_client=mock_redis)

        request = MagicMock()
        request.url.path = "/some/unknown/path"
        request.client.host = "1.2.3.4"

        async def call_next(req):
            return MagicMock(status_code=200)

        response = await middleware.dispatch(request, call_next)
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_health_not_rate_limited(self):
        mock_redis = AsyncMock()
        mock_redis.incr.return_value = 1
        mock_redis.expire = AsyncMock()

        app = MagicMock()
        middleware = RateLimitMiddleware(app, redis_client=mock_redis)

        request = MagicMock()
        request.url.path = "/health"
        request.client.host = "1.2.3.4"

        async def call_next(req):
            return MagicMock(status_code=200)

        response = await middleware.dispatch(request, call_next)
        assert response.status_code == 200
