"""Async Redis client (redis-py 5.0+).

Lazy initialisation: call ``init()`` during application startup.
If ``redis.enabled`` is false the module skips connection entirely.

Usage:
    from app.infra.redis import init, close, client, k, jget, jset, lock

    # startup
    await init()

    # key helpers with prefix
    await jset(k("profile", "42"), {"name": "Alice"}, ex=3600)
    data = await jget(k("profile", "42"))

    # distributed lock
    async with lock(k("task", "sync")):
        ...

    # shutdown
    await close()
"""

from __future__ import annotations

import json as _json
import secrets
import time
from contextlib import asynccontextmanager
from typing import Any

from loguru import logger
from redis.asyncio import ConnectionPool, Redis
from redis.asyncio.client import PubSub

from app.infra.config import config

# Prefer orjson if available, fall back to stdlib json.
try:
    import orjson as _serializer
except Exception:  # pragma: no cover
    _serializer = _json  # type: ignore[assignment]


# Module-level state — populated by init()
_pool: ConnectionPool | None = None
client: Redis | None = None
# Alias kept in sync with ``client`` so callers can do
# ``from app.infra import redis; redis.redis_client`` (runtime attribute
# access — NOT ``from app.infra.redis import redis_client``, which would
# bind the pre-init None forever).  Some legacy call sites still use the
# ``redis_client`` name; new code should prefer ``client``.
redis_client: Redis | None = None

# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


async def init() -> None:
    """Create the connection pool and verify connectivity.

    Raises on failure because Redis is treated as a required dependency
    when enabled.
    """
    global _pool, client, redis_client

    if not config.redis.enabled:
        logger.info("[REDIS] disabled, skipping init")
        return

    _pool = ConnectionPool.from_url(
        config.redis.url,
        max_connections=config.redis.max_connections,
        socket_timeout=config.redis.socket_timeout,
        socket_connect_timeout=config.redis.socket_connect_timeout,
        health_check_interval=config.redis.health_check_interval,
        decode_responses=False,
    )
    client = Redis(connection_pool=_pool)
    redis_client = client

    result = await ping()
    if not result["ok"]:
        raise RuntimeError(f"[REDIS] init failed: {result['error']}")

    await _register_scripts()
    logger.info("[REDIS] connected: latency={}ms", result["latency_ms"])


async def close() -> None:
    """Disconnect and drain the pool."""
    global _pool, client, redis_client
    if client is not None:
        await client.aclose()
    if _pool is not None:
        await _pool.aclose()
    client = None
    redis_client = None
    _pool = None
    logger.info("[REDIS] closed")


async def ping() -> dict[str, Any]:
    """Return connection health with round-trip latency in milliseconds."""
    if client is None:
        return {"ok": False, "latency_ms": 0, "error": "not initialized"}
    start = time.time()
    try:
        await client.ping()
        return {
            "ok": True,
            "latency_ms": int((time.time() - start) * 1000),
            "error": None,
        }
    except Exception as exc:
        return {
            "ok": False,
            "latency_ms": int((time.time() - start) * 1000),
            "error": str(exc),
        }


# ---------------------------------------------------------------------------
# Key namespace
# ---------------------------------------------------------------------------


def k(*parts: str) -> str:
    """Build a prefixed key: ``k('session', sid)`` → ``mind-base:session:{sid}``."""
    return config.redis.key_prefix + ":".join(parts)


# ---------------------------------------------------------------------------
# JSON helpers
# ---------------------------------------------------------------------------


def _dump(value: Any) -> bytes:
    if _serializer is _json:
        return _serializer.dumps(value).encode()
    return _serializer.dumps(value)


def _load(raw: bytes) -> Any:
    if _serializer is _json:
        return _serializer.loads(raw.decode())
    return _serializer.loads(raw)


async def jset(key: str, value: Any, ex: int | None = None) -> None:
    """Serialise *value* to JSON and SET *key* with optional TTL."""
    if client is None:
        raise RuntimeError("[REDIS] not initialized")
    await client.set(key, _dump(value), ex=ex)


async def jget(key: str) -> Any | None:
    """GET *key* and deserialise JSON.  Returns ``None`` if missing."""
    if client is None:
        raise RuntimeError("[REDIS] not initialized")
    raw = await client.get(key)
    if raw is None:
        return None
    return _load(raw)


async def jhset(key: str, field: str, value: Any) -> None:
    """HSET *key* *field* with a JSON-serialised value."""
    if client is None:
        raise RuntimeError("[REDIS] not initialized")
    await client.hset(key, field, _dump(value))


async def jhget(key: str, field: str) -> Any | None:
    """HGET *key* *field* and deserialise JSON."""
    if client is None:
        raise RuntimeError("[REDIS] not initialized")
    raw = await client.hget(key, field)
    if raw is None:
        return None
    return _load(raw)


# ---------------------------------------------------------------------------
# Lua scripts (atomic operations)
# ---------------------------------------------------------------------------

_RATE_LIMIT_LUA = """
local current = redis.call('INCR', KEYS[1])
if current == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
end
if current > tonumber(ARGV[2]) then
    return 0
end
return 1
"""

_CAS_DELETE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
"""

_scripts: dict[str, Any] = {}


async def _register_scripts() -> None:
    """Register Lua scripts at startup."""
    global _scripts
    if client is None:
        return
    _scripts["rate_limit"] = client.register_script(_RATE_LIMIT_LUA)
    _scripts["cas_delete"] = client.register_script(_CAS_DELETE_LUA)
    logger.debug("[REDIS] registered {} Lua scripts", len(_scripts))


async def rate_limit(key: str, max_per_window: int, window_sec: int) -> bool:
    """Fixed-window rate limiter.  Returns ``True`` if allowed."""
    script = _scripts.get("rate_limit")
    if script is None or client is None:
        raise RuntimeError("[REDIS] not initialized")
    result = await script(keys=[key], args=[window_sec, max_per_window])
    return bool(result)


async def cas_delete(key: str, expected: bytes | str) -> bool:
    """Delete *key* only if its current value equals *expected*."""
    script = _scripts.get("cas_delete")
    if script is None or client is None:
        raise RuntimeError("[REDIS] not initialized")
    if isinstance(expected, str):
        expected = expected.encode()
    result = await script(keys=[key], args=[expected])
    return bool(result)


# ---------------------------------------------------------------------------
# Pub/Sub
# ---------------------------------------------------------------------------


async def publish(channel: str, message: Any) -> int:
    """Publish a JSON-serialised message to *channel*."""
    if client is None:
        raise RuntimeError("[REDIS] not initialized")
    return await client.publish(channel, _dump(message))


def pubsub() -> PubSub:
    """Return a PubSub handle for subscribing."""
    if client is None:
        raise RuntimeError("[REDIS] not initialized")
    return client.pubsub()


# ---------------------------------------------------------------------------
# Distributed lock (SET NX EX)
# ---------------------------------------------------------------------------


def is_enabled() -> bool:
    """Return True if Redis is initialized and connected."""
    return client is not None


@asynccontextmanager
async def lock(key: str, ttl: int = 30) -> Any:
    """Acquire a distributed lock on *key* with *ttl* seconds.

    Usage:
        async with redis.lock(k("task", task_id)):
            ...
    """
    if client is None:
        raise RuntimeError("[REDIS] not initialized")
    token = secrets.token_hex(16)
    acquired = await client.set(key, token, nx=True, ex=ttl)
    if not acquired:
        raise RuntimeError(f"[REDIS] lock contention: {key}")
    try:
        yield
    finally:
        await cas_delete(key, token)
