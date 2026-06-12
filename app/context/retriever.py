"""Context retrieval from MongoDB — recent messages and pattern search.

Provides two retrieval strategies for conversation history:

1. **Recent** — fetch the last N messages by recency (for sliding-window
   compression).
2. **Grep** — full-text pattern match against message content via MongoDB
   ``$regex``, useful when the current question mentions a specific topic
   (entity name, technical term, filename) that the user discussed earlier.

The two strategies can be combined: grep finds semantically relevant
messages; recent messages provide temporal continuity.  Deduplication
and timestamp ordering are handled automatically.

Usage::

    retriever = ContextRetriever()

    # Just get recent messages
    recent = await retriever.get_recent_messages(session_id, n_messages=200)

    # Pattern search
    matched = await retriever.grep(session_id, "Python装饰器")

    # Combined retrieval + compress in one call
    result = await retriever.retrieve_and_compress(
        session_id,
        compressor=compressor,
        summarize_fn=summarize,
        query="Python装饰器怎么用",
        pattern="装饰器|decorator",
        n_recent=200,
    )
"""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

from pymongo import ASCENDING, DESCENDING

from .compressor import ConversationCompressor, SummarizeFn
from .models import ConversationMessage
from .store_mongo import _mongo_doc_to_message

if TYPE_CHECKING:
    from .cache import CachedSummary
    from .compressor import CompressionResult

logger = logging.getLogger(__name__)

COLLECTION = "chat_messages"
DEFAULT_RECENT_LIMIT = 200  # ~100 turns
DEFAULT_GREP_LIMIT = 200


async def _cache_get(chat_session_id: str) -> "CachedSummary | None":
    """Read compressed summary from Redis.  Returns None on any failure."""
    from .cache import get_cached

    return await get_cached(chat_session_id)


async def _cache_set(
    chat_session_id: str, result: "CompressionResult", ttl: int
) -> None:
    """Write compressed summary to Redis (best-effort)."""
    from .cache import set_cached

    await set_cached(chat_session_id, result, ttl=ttl)


def _deduplicate(
    messages: list[ConversationMessage],
) -> list[ConversationMessage]:
    """Remove duplicate messages (same content + approximate timestamp)."""
    seen: set[tuple[str, int]] = set()
    result: list[ConversationMessage] = []
    for m in messages:
        key = (m.content, int(m.timestamp))
        if key not in seen:
            seen.add(key)
            result.append(m)
    return result


# ---------------------------------------------------------------------------
# Retriever
# ---------------------------------------------------------------------------


class ContextRetriever:
    """Retrieve conversation context from MongoDB chat_messages.

    Designed to work alongside ``ContextManager``: the manager handles
    in-memory short-term context; the retriever fetches long-term history
    from MongoDB for compression or search.
    """

    def __init__(
        self,
        recent_limit: int = DEFAULT_RECENT_LIMIT,
        grep_limit: int = DEFAULT_GREP_LIMIT,
    ) -> None:
        self._recent_limit = recent_limit
        self._grep_limit = grep_limit

    # ------------------------------------------------------------------
    # single-strategy retrieval
    # ------------------------------------------------------------------

    async def get_recent_messages(
        self,
        chat_session_id: str,
        n_messages: int | None = None,
    ) -> list[ConversationMessage]:
        """Fetch the last *n_messages* for a session, newest-first.

        Returns messages in chronological order (oldest → newest) so
        they can be fed directly to ``ConversationCompressor.compress()``.

        Args:
            chat_session_id: The chat session to query.
            n_messages: Number of recent messages. Defaults to the
                        retriever's configured limit (~200 = 100 turns).
        """
        from app.infra.mongo import coll, is_enabled

        if not is_enabled():
            logger.warning("[RETRIEVER] mongo disabled")
            return []

        limit = n_messages if n_messages is not None else self._recent_limit

        cursor = (
            coll(COLLECTION)
            .find(
                {"chat_session_id": chat_session_id},
                {"content": 1, "role": 1, "created_at": 1, "_id": 0},
            )
            .sort("created_at", DESCENDING)
            .limit(limit)
        )
        docs = await cursor.to_list(length=limit)

        if not docs:
            return []

        # MongoDB returns newest-first; reverse to chronological
        docs.reverse()
        messages = [_mongo_doc_to_message(d) for d in docs]
        logger.debug(
            "[RETRIEVER] recent session=%s count=%s",
            chat_session_id,
            len(messages),
        )
        return messages

    async def grep(
        self,
        chat_session_id: str,
        pattern: str,
        limit: int | None = None,
        *,
        case_sensitive: bool = False,
    ) -> list[ConversationMessage]:
        """Search messages whose content matches *pattern* (MongoDB ``$regex``).

        The pattern is treated as a raw regex string.  For a simple keyword
        OR-search, use ``"keyword1|keyword2"``.

        Args:
            chat_session_id: The chat session to search within.
            pattern: Regex pattern matched against the ``content`` field.
            limit: Max messages to return (default: 100).
            case_sensitive: If False (default), uses case-insensitive matching.

        Returns:
            Chronologically ordered list of matching messages.
        """
        from app.infra.mongo import coll, is_enabled

        if not is_enabled():
            logger.warning("[RETRIEVER] mongo disabled")
            return []

        limit_val = limit if limit is not None else self._grep_limit

        try:
            # Validate regex before sending to MongoDB
            re.compile(pattern)
        except re.error as exc:
            logger.warning("[RETRIEVER] invalid regex pattern=%s err=%s", pattern, exc)
            # Fall back to literal substring match
            pattern = re.escape(pattern)

        mongo_flags = "" if case_sensitive else "i"

        cursor = (
            coll(COLLECTION)
            .find(
                {
                    "chat_session_id": chat_session_id,
                    "content": {"$regex": pattern, "$options": mongo_flags},
                },
                {"content": 1, "role": 1, "created_at": 1, "_id": 0},
            )
            .sort("created_at", ASCENDING)
            .limit(limit_val)
        )
        docs = await cursor.to_list(length=limit_val)

        messages = [_mongo_doc_to_message(d) for d in docs]
        logger.debug(
            "[RETRIEVER] grep session=%s pattern=%s count=%s",
            chat_session_id,
            pattern[:80],
            len(messages),
        )
        return messages

    # ------------------------------------------------------------------
    # combined retrieval
    # ------------------------------------------------------------------

    async def retrieve(
        self,
        chat_session_id: str,
        *,
        pattern: str | None = None,
        n_recent: int | None = None,
    ) -> list[ConversationMessage]:
        """Combined retrieval: grep (optional) + recent messages.

        When *pattern* is provided, the result is the union of:
        1. Messages matched by grep (topic-relevant)
        2. The last *n_recent* messages (temporal continuity)

        Results are deduplicated and returned in chronological order.

        Args:
            chat_session_id: The chat session to query.
            pattern: Optional regex pattern for grep.
            n_recent: Number of recent messages to include.

        Returns:
            Chronologically ordered, deduplicated message list.
        """
        results: list[ConversationMessage] = []

        # Fetch in parallel
        import asyncio

        tasks = []

        async def _add_recent() -> None:
            msgs = await self.get_recent_messages(chat_session_id, n_recent)
            results.extend(msgs)

        async def _add_grep(p: str) -> None:
            msgs = await self.grep(chat_session_id, p)
            results.extend(msgs)

        tasks.append(_add_recent())
        if pattern:
            tasks.append(_add_grep(pattern))

        await asyncio.gather(*tasks)

        if not results:
            return []

        # Sort by timestamp, deduplicate
        results.sort(key=lambda m: m.timestamp)
        results = _deduplicate(results)

        logger.info(
            "[RETRIEVER] retrieve session=%s total=%s pattern=%s",
            chat_session_id,
            len(results),
            pattern,
        )
        return results

    async def retrieve_and_compress(
        self,
        chat_session_id: str,
        compressor: ConversationCompressor,
        summarize_fn: SummarizeFn,
        *,
        pattern: str | None = None,
        n_recent: int | None = None,
        use_cache: bool = True,
        cache_ttl: int = 300,
    ) -> CompressionResult:
        """Retrieve messages and run compression, with Redis cache-aside.

        Cache-hit path (fast, no LLM cost)::

            Redis GET → cached summary → return immediately

        Cache-miss path::

            1. Retrieve from MongoDB (grep + recent, original docs untouched)
            2. Compress via LLM
            3. Store compressed result in Redis (TTL)
            4. Return ``CompressionResult``

        Args:
            chat_session_id: The chat session to query.
            compressor: A configured ``ConversationCompressor`` instance.
            summarize_fn: The summarization function.
            pattern: Optional regex pattern for topic-relevant search.
            n_recent: Number of recent messages (default: 200).
            use_cache: If False, skip Redis and always re-compress.
            cache_ttl: Redis TTL in seconds (default: 300 = 5 min).

        Returns:
            A ``CompressionResult`` ready for LLM context injection.
        """
        from .compressor import CompressionResult

        # ── cache-hit path ──────────────────────────────────────────
        if use_cache:
            cached = await _cache_get(chat_session_id)
            if cached is not None:
                logger.info(
                    "[RETRIEVER] cache-hit session=%s summary_len=%s",
                    chat_session_id,
                    len(cached.summary) if cached.summary else 0,
                )
                return CompressionResult(
                    summary=cached.summary,
                    kept_messages=[],  # recent messages not cached
                    compressed_count=cached.compressed_count,
                    did_compress=True,
                )

        # ── cache-miss path ─────────────────────────────────────────
        messages = await self.retrieve(
            chat_session_id,
            pattern=pattern,
            n_recent=n_recent,
        )

        if not messages:
            logger.info("[RETRIEVER] no messages for session=%s", chat_session_id)
            return CompressionResult(
                summary=compressor.summary,
                kept_messages=[],
                compressed_count=0,
            )

        result = await compressor.compress(messages, summarize_fn)

        # Store in Redis (best-effort, never blocks the response)
        if use_cache and result.summary:
            await _cache_set(chat_session_id, result, ttl=cache_ttl)

        logger.info(
            "[RETRIEVER] compress done session=%s input=%s compressed=%s "
            "kept=%s has_summary=%s",
            chat_session_id,
            len(messages),
            result.compressed_count,
            len(result.kept_messages),
            result.summary is not None,
        )
        return result


# ---------------------------------------------------------------------------
# convenience — build a summary string suitable for system-message injection
# ---------------------------------------------------------------------------


def build_context_injection(result: CompressionResult) -> str | None:
    """Format a ``CompressionResult`` as a human-readable context block.

    Can be directly appended to the system prompt or prepended as a
    ``SystemMessage`` in the LLM call.

    Returns None when there is no context (nothing retrieved, nothing
    compressed, nothing in recent window).
    """
    parts: list[str] = []

    if result.summary:
        parts.append(f"【历史记忆】\n{result.summary}")

    if result.kept_messages:
        recent_text = _messages_to_text(result.kept_messages)
        parts.append(f"【最近对话】\n{recent_text}")

    if not parts:
        return None

    return "\n\n".join(parts)


def _messages_to_text(messages: list[ConversationMessage]) -> str:
    lines: list[str] = []
    for m in messages:
        role = "用户" if m.role == "user" else "助手"
        content = m.content.replace("\n", " ").strip()
        lines.append(f"{role}：{content}")
    return "\n".join(lines)
