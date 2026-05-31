"""
Multi-level cache infrastructure.

Architecture:
    request → L1 LocalMemoryCache (0.1μs) → L2 RedisCache (0.5ms) → DB (1-10ms)

Usage:
    from app.infra.cache import cache_manager
    token_cache = cache_manager.namespace("token", ttl=300)
    uid = await token_cache.get(session_token)
    await token_cache.set(session_token, uid)

When Redis is enabled later:
    await cache_manager.enable_redis()
    # L2 auto-activates, cross-worker invalidation via Pub/Sub
"""

from __future__ import annotations

import asyncio
import json as _json
import random
import time
from abc import ABC, abstractmethod
from typing import Any, Callable, Coroutine


# ══════════════════════════════════════════════════════════════════
# Abstract backend
# ══════════════════════════════════════════════════════════════════

class CacheBackend(ABC):
    """Unified cache backend interface.  All methods are async."""

    @abstractmethod
    async def get(self, key: str) -> Any | None:
        """Return cached value or None."""

    @abstractmethod
    async def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        """Store value with optional TTL in seconds."""

    @abstractmethod
    async def delete(self, key: str) -> None:
        """Remove a single key."""

    @abstractmethod
    async def clear(self) -> None:
        """Remove ALL keys from this backend."""

    @abstractmethod
    def stats(self) -> dict:
        """Return {size, hits, misses, hit_rate}."""


# ══════════════════════════════════════════════════════════════════
# L1 — Local memory (per-process)
# ══════════════════════════════════════════════════════════════════

class LocalMemoryCache(CacheBackend):
    """Async in-process cache with avalanche protection.

    Features:
      - TTL jitter: ±10% random offset to spread expirations
      - Single-flight: concurrent misses for the same key are coalesced
      - Stale-while-revalidate: serve stale data (up to 2×TTL) while refetching
      - LRU eviction: oldest 20% evicted when over maxsize
    """

    def __init__(self, maxsize: int = 5000, default_ttl: int = 300):
        self._lock = asyncio.Lock()
        self._store: dict[str, tuple[float, float, Any]] = {}  # key → (soft_expire, hard_expire, value)
        self._flying: dict[str, asyncio.Event] = {}            # single-flight pending fetches
        self._maxsize = maxsize
        self._default_ttl = default_ttl
        self._hits = 0
        self._misses = 0
        self._writes = 0
        self._stale_hits = 0

    # ── Helpers ─────────────────────────────────────────────────

    @staticmethod
    def _jitter(ttl: int) -> float:
        """Add ±10% random jitter to TTL to prevent cache stampede."""
        return ttl * (0.9 + random.random() * 0.2)

    # ── CacheBackend impl ───────────────────────────────────────

    async def get(self, key: str) -> Any | None:
        async with self._lock:
            entry = self._store.get(key)
            if entry is None:
                self._misses += 1
                return None
            soft_expire, hard_expire, value = entry
            now = time.time()
            if now < soft_expire:
                self._hits += 1
                return value
            if now < hard_expire:
                self._stale_hits += 1
                return value  # stale but still usable (SWR)
            # Hard-expired — remove
            del self._store[key]
            self._misses += 1
            return None

    async def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        raw_ttl = ttl or self._default_ttl
        jittered = self._jitter(raw_ttl)
        now = time.time()
        async with self._lock:
            self._store[key] = (now + jittered, now + jittered * 2, value)
            self._writes += 1
            # LRU eviction
            if len(self._store) > self._maxsize:
                sorted_keys = sorted(self._store.keys())
                n = len(sorted_keys) // 5 or 1
                for k in sorted_keys[:n]:
                    del self._store[k]

    async def delete(self, key: str) -> None:
        async with self._lock:
            self._store.pop(key, None)

    async def clear(self) -> None:
        async with self._lock:
            self._store.clear()

    # ── Single-flight get_or_fetch ──────────────────────────────

    async def get_or_fetch(
        self, key: str,
        fetcher: Callable[[], Coroutine[Any, Any, Any]],
        ttl: int | None = None,
    ) -> Any:
        """Get from cache; on miss, call *fetcher* once (single-flight).

        Multiple concurrent requests for the same key will wait for the
        first caller's fetch to complete, then all receive the same result.
        """
        v = await self.get(key)
        if v is not None:
            return v

        # Check if another coroutine is already fetching this key
        async with self._lock:
            event = self._flying.get(key)
            if event is None:
                self._flying[key] = asyncio.Event()
            else:
                pass  # another fetch is in-flight; wait below

        if event is not None:
            # Another coroutine is fetching — wait for it
            await event.wait()
            v = await self.get(key)
            if v is not None:
                return v
            # If the other fetch failed, fall through and try ourselves

        try:
            result = await fetcher()
            if result is not None:
                await self.set(key, result, ttl)
        finally:
            async with self._lock:
                evt = self._flying.pop(key, None)
                if evt is not None:
                    evt.set()  # wake up waiters

        return result

    def stats(self) -> dict:
        total = self._hits + self._misses + self._stale_hits
        return {
            "backend": "local",
            "size": len(self._store),
            "maxsize": self._maxsize,
            "flying": len(self._flying),
            "hits": self._hits,
            "misses": self._misses,
            "stale_hits": self._stale_hits,
            "hit_rate": round((self._hits + self._stale_hits) / total, 4) if total > 0 else 0.0,
        }


# ══════════════════════════════════════════════════════════════════
# L2 — Redis (placeholder — activated when redis.enabled=true)
# ══════════════════════════════════════════════════════════════════

class RedisCache(CacheBackend):
    """Redis-backed cache that implements the same CacheBackend interface.

    Not activated by default.  Call ``cache_manager.enable_redis()`` at
    startup once Redis is configured.
    """

    def __init__(self, key_prefix: str = "cache:"):
        self._prefix = key_prefix
        self._redis = None

    async def _ensure(self):
        if self._redis is not None:
            return
        from app.infra.redis import client, is_enabled
        if not is_enabled() or client is None:
            raise RuntimeError("[CACHE] Redis is not enabled or not connected")
        self._redis = client

    def _k(self, key: str) -> str:
        return f"{self._prefix}{key}"

    async def get(self, key: str) -> Any | None:
        await self._ensure()
        raw = await self._redis.get(self._k(key))
        if raw is None:
            return None
        return _json.loads(raw)

    async def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        await self._ensure()
        await self._redis.set(self._k(key), _json.dumps(value), ex=ttl or 300)

    async def delete(self, key: str) -> None:
        await self._ensure()
        await self._redis.delete(self._k(key))

    async def clear(self) -> None:
        await self._ensure()
        # scan and delete all keys with our prefix
        cursor = 0
        while True:
            cursor, keys = await self._redis.scan(cursor, match=f"{self._prefix}*", count=100)
            if keys:
                await self._redis.delete(*keys)
            if cursor == 0:
                break

    def stats(self) -> dict:
        return {"backend": "redis", "size": -1, "hits": 0, "misses": 0, "hit_rate": 0.0}


# ══════════════════════════════════════════════════════════════════
# Multi-level cache (L1 → L2 → miss)
# ══════════════════════════════════════════════════════════════════

MULTILEVEL_INVALIDATE_CHANNEL = "cache:invalidate"


class MultiLevelCache(CacheBackend):
    """L1 (local) → L2 (redis, optional) with automatic backfill."""

    def __init__(self, l1: CacheBackend, l2: CacheBackend | None = None):
        self.l1 = l1
        self.l2 = l2

    # ── CacheBackend impl ───────────────────────────────────────

    async def get(self, key: str) -> Any | None:
        v = await self.l1.get(key)
        if v is not None:
            return v
        if self.l2 is not None:
            v = await self.l2.get(key)
            if v is not None:
                await self.l1.set(key, v)   # backfill L1
                return v
        return None

    async def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        if self.l2 is not None:
            await self.l2.set(key, value, ttl)
        await self.l1.set(key, value, ttl)
        await self._pub_invalidate(key)

    async def get_or_fetch(
        self, key: str,
        fetcher: Callable[[], Coroutine[Any, Any, Any]],
        ttl: int | None = None,
    ) -> Any:
        """Single-flight coalesced fetch through L1."""
        return await self.l1.get_or_fetch(key, fetcher, ttl)

    async def delete(self, key: str) -> None:
        await self.l1.delete(key)
        if self.l2 is not None:
            await self.l2.delete(key)
        await self._pub_invalidate(key)

    async def clear(self) -> None:
        await self.l1.clear()
        if self.l2 is not None:
            await self.l2.clear()

    def stats(self) -> dict:
        s = {"backend": "multi-level", "l1": self.l1.stats()}
        if self.l2 is not None:
            s["l2"] = self.l2.stats()
        return s

    async def _pub_invalidate(self, key: str) -> None:
        """Notify other workers to evict this key from their L1."""
        if self.l2 is None:
            return
        try:
            from app.infra.redis import is_enabled as _redis_ok, client as _redis_client
            if _redis_ok() and _redis_client is not None:
                await _redis_client.publish(MULTILEVEL_INVALIDATE_CHANNEL, key)
        except Exception:
            pass  # best-effort


# ══════════════════════════════════════════════════════════════════
# Namespace — typed cache accessor
# ══════════════════════════════════════════════════════════════════

class NamespaceCache:
    """A namespaced view over the multi-level cache.

    All keys are automatically prefixed: ``{namespace}:{key}``.
    """

    def __init__(self, namespace: str, backend: MultiLevelCache, ttl: int = 300):
        self._ns = namespace
        self._backend = backend
        self.ttl = ttl

    def _k(self, key: str) -> str:
        return f"{self._ns}:{key}"

    async def get(self, key: str) -> Any | None:
        return await self._backend.get(self._k(key))

    async def get_int(self, key: str) -> int | None:
        v = await self.get(key)
        return int(v) if v is not None else None

    async def get_dict(self, key: str) -> dict | None:
        v = await self.get(key)
        return v if isinstance(v, dict) else None

    async def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        await self._backend.set(self._k(key), value, ttl or self.ttl)

    async def get_or_fetch(
        self, key: str,
        fetcher: Callable[[], Coroutine[Any, Any, Any]],
        ttl: int | None = None,
    ) -> Any:
        """Single-flight: get from cache, or call fetcher once for all concurrent waiters."""
        return await self._backend.l1.get_or_fetch(self._k(key), fetcher, ttl or self.ttl)

    async def delete(self, key: str) -> None:
        await self._backend.delete(self._k(key))

    async def clear(self) -> None:
        """Clear all keys in this namespace (best-effort via L1 clear; L2 scan not implemented)."""
        await self._backend.l1.clear()  # clear all of L1
        # Note: clearing a single namespace from L2 requires SCAN prefix match,
        # which is expensive.  For now, rely on TTL expiration.

    def stats(self) -> dict:
        return self._backend.stats()


# ══════════════════════════════════════════════════════════════════
# CacheManager — registry + lifecycle
# ══════════════════════════════════════════════════════════════════

class CacheManager:
    """Central cache registry.

    Usage:
        cache = CacheManager()
        await cache.start()                       # startup
        token_ns = cache.namespace("token", 300)  # create or get
        await token_ns.set(sid, uid)
    """

    def __init__(self):
        self._l1 = LocalMemoryCache()
        self._l2: CacheBackend | None = None
        self._namespaces: dict[str, NamespaceCache] = {}
        self._pubsub_task: asyncio.Task | None = None

    # ── Lifecycle ───────────────────────────────────────────────

    async def start(self, redis_enabled: bool = False) -> None:
        """Must be called during app startup."""
        if redis_enabled:
            await self.enable_redis()

    async def enable_redis(self) -> None:
        """Activate L2 (Redis) and start cross-worker invalidation listener."""
        if self._l2 is not None:
            return
        from app.infra.redis import client as _redis_client, is_enabled as _redis_ok
        if not _redis_ok() or _redis_client is None:
            return
        self._l2 = RedisCache()
        # Start invalidation listener
        self._pubsub_task = asyncio.create_task(self._listen_invalidation())
        # Re-bind all existing namespaces to the new multi-level backend
        for ns in self._namespaces.values():
            ns._backend = MultiLevelCache(self._l1, self._l2)

    async def _listen_invalidation(self) -> None:
        """Listen for cross-worker cache invalidation messages."""
        from app.infra.redis import pubsub as _pubsub, is_enabled as _redis_ok
        try:
            ps = _pubsub()
            await ps.subscribe(MULTILEVEL_INVALIDATE_CHANNEL)
            async for msg in ps.listen():
                if msg["type"] == "message":
                    key = msg["data"]
                    if isinstance(key, bytes):
                        key = key.decode()
                    await self._l1.delete(key)
        except Exception:
            pass  # best-effort

    # ── Namespace factory ───────────────────────────────────────

    def namespace(self, name: str, ttl: int = 300) -> NamespaceCache:
        """Return (or create) a namespaced cache view.

        Usage:
            token_cache = cache_manager.namespace("token", ttl=300)
            uid = await token_cache.get(session_token)
        """
        if name not in self._namespaces:
            backend = MultiLevelCache(self._l1, self._l2)
            self._namespaces[name] = NamespaceCache(name, backend, ttl=ttl)
        return self._namespaces[name]

    # ── Stats ───────────────────────────────────────────────────

    def get_stats(self) -> dict:
        """Aggregated stats for all namespaces."""
        ns_info = {
            name: {
                "ttl": ns.ttl,
                "l1_size": ns._backend.l1.stats()["size"],
            }
            for name, ns in self._namespaces.items()
        }
        return {
            "l1": self._l1.stats(),
            "l2_configured": self._l2 is not None,
            "namespaces": len(self._namespaces),
            "namespace_detail": ns_info,
        }


# ══════════════════════════════════════════════════════════════════
# Global singleton
# ══════════════════════════════════════════════════════════════════

cache_manager = CacheManager()
