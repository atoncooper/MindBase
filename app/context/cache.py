"""Redis cache layer for compressed conversation summaries.

Caches ``CompressionResult`` (summary + kept messages) keyed by
chat_session_id.  Invalidation happens on two paths:

1. **Active** — ``invalidate()`` is called whenever a new message is
   appended to the chat session (triggered by the caller after
   ``ContextManager.add_turn()``).
2. **Passive** — TTL expiry (default 5 minutes).  Even if invalidation
   is missed, stale cache entries self-destruct quickly.

MongoDB is never written to by this module — it reads from MongoDB
(original messages) and writes the compressed result to Redis only.

All functions gracefully degrade when Redis is not installed or disabled.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .compressor import CompressionResult

logger = logging.getLogger(__name__)

# Redis key namespace segment
_NS = "ctx"

# Default TTL for cached summaries (seconds)
DEFAULT_TTL = 300  # 5 minutes


def _redis_ok() -> bool:
    """Return True if Redis is ready.  Handles import errors gracefully."""
    try:
        from app.infra.redis import is_enabled
        return is_enabled()
    except Exception:
        return False


def _cache_key(chat_session_id: str) -> str:
    from app.infra.redis import k as _rk
    return _rk(_NS, "compressed", chat_session_id)


@dataclass
class CachedSummary:
    """Deserialised cache entry."""

    summary: str | None
    kept_message_count: int
    compressed_count: int
    cached_at: float


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------


async def get_cached(chat_session_id: str) -> CachedSummary | None:
    """Return the cached compressed summary, or None on miss / Redis down."""
    if not _redis_ok():
        return None
    try:
        from app.infra.redis import jget
        raw = await jget(_cache_key(chat_session_id))
    except Exception:
        logger.warning("[CTX_CACHE] get failed", exc_info=True)
        return None
    if raw is None:
        return None
    try:
        return CachedSummary(
            summary=raw.get("summary"),
            kept_message_count=raw.get("kept_count", 0),
            compressed_count=raw.get("compressed_count", 0),
            cached_at=raw.get("cached_at", 0),
        )
    except Exception:
        logger.warning("[CTX_CACHE] deserialise failed", exc_info=True)
        return None


async def set_cached(
    chat_session_id: str,
    result: CompressionResult,
    ttl: int = DEFAULT_TTL,
) -> None:
    """Store a compression result in Redis with the given TTL."""
    if not _redis_ok():
        return
    payload = {
        "summary": result.summary,
        "kept_count": len(result.kept_messages),
        "compressed_count": result.compressed_count,
        "cached_at": time.time(),
    }
    try:
        from app.infra.redis import jset
        await jset(_cache_key(chat_session_id), payload, ex=ttl)
        logger.debug(
            "[CTX_CACHE] set session={} ttl={}s summary_len={}",
            chat_session_id,
            ttl,
            len(result.summary) if result.summary else 0,
        )
    except Exception:
        logger.warning("[CTX_CACHE] set failed", exc_info=True)


async def invalidate(chat_session_id: str) -> bool:
    """Delete the cached summary for a session.  Call after new messages arrive.

    Returns True if a cache entry was actually removed.
    """
    if not _redis_ok():
        return False
    try:
        from app.infra.redis import client as _redis

        if _redis is None:
            return False
        deleted = await _redis.delete(_cache_key(chat_session_id))
        if deleted:
            logger.debug("[CTX_CACHE] invalidated session={}", chat_session_id)
        return bool(deleted)
    except Exception:
        logger.warning("[CTX_CACHE] invalidate failed", exc_info=True)
        return False


async def ttl(chat_session_id: str) -> int:
    """Return remaining TTL in seconds, -1 if no expiry, -2 if missing."""
    if not _redis_ok():
        return -2
    try:
        from app.infra.redis import client as _redis

        if _redis is None:
            return -2
        return await _redis.ttl(_cache_key(chat_session_id))
    except Exception:
        return -2
