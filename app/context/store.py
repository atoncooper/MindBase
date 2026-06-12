"""Conversation storage backends — abstract interface + in-memory implementation."""

from __future__ import annotations

import asyncio
import logging
import time
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

from .config import ContextConfig
from .models import ConversationContext, ConversationMessage

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)


class ConversationStore(ABC):
    """Abstract interface for conversation context storage.

    Implementations: InMemoryStore (default), future RedisStore, DBStore.
    """

    @abstractmethod
    async def load(self, session_id: str) -> ConversationContext | None:
        """Load the full context for a session, or None."""

    @abstractmethod
    async def save(self, session_id: str, context: ConversationContext) -> None:
        """Persist (create or overwrite) a full context."""

    @abstractmethod
    async def append(self, session_id: str, message: ConversationMessage) -> None:
        """Append a single message to an existing session context."""

    @abstractmethod
    async def append_batch(self, session_id: str, messages: list[ConversationMessage]) -> None:
        """Append multiple messages atomically in a single lock acquisition."""

    @abstractmethod
    async def delete(self, session_id: str) -> bool:
        """Remove a session. Returns True if it existed."""

    @abstractmethod
    async def exists(self, session_id: str) -> bool:
        """Check whether a session has stored context."""

    @abstractmethod
    async def session_count(self) -> int:
        """Return the number of active sessions."""

    @abstractmethod
    async def cleanup_expired(self, ttl_seconds: float) -> int:
        """Remove sessions older than ttl_seconds. Returns removed count."""


class InMemoryStore(ConversationStore):
    """Dict-based conversation store protected by per-session asyncio locks."""

    def __init__(self, config: ContextConfig) -> None:
        self._config = config
        self._store: dict[str, ConversationContext] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._global_lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # lock management
    # ------------------------------------------------------------------

    async def _get_lock(self, session_id: str) -> asyncio.Lock:
        """Get or create a per-session lock (thread-safe)."""
        if session_id in self._locks:
            return self._locks[session_id]
        async with self._global_lock:
            if session_id not in self._locks:
                self._locks[session_id] = asyncio.Lock()
            return self._locks[session_id]

    def _cleanup_lock(self, session_id: str) -> None:
        """Remove the lock for a deleted session."""
        self._locks.pop(session_id, None)

    # ------------------------------------------------------------------
    # store API
    # ------------------------------------------------------------------

    async def load(self, session_id: str) -> ConversationContext | None:
        lock = await self._get_lock(session_id)
        async with lock:
            ctx = self._store.get(session_id)
            if ctx is None:
                return None
            if self._is_expired(ctx):
                await self._evict(session_id)
                return None
            ctx.touch()  # auto-renew TTL on access
            return ctx

    async def save(self, session_id: str, context: ConversationContext) -> None:
        lock = await self._get_lock(session_id)
        async with lock:
            if self._config.max_sessions > 0 and len(self._store) >= self._config.max_sessions:
                if session_id not in self._store:
                    await self._evict_lru()
            self._store[session_id] = context
            context.touch()

    async def append(self, session_id: str, message: ConversationMessage) -> None:
        lock = await self._get_lock(session_id)
        async with lock:
            ctx = self._store.get(session_id)
            if ctx is None:
                ctx = ConversationContext(session_id=session_id)
                self._store[session_id] = ctx
            ctx.messages.append(message)
            ctx.touch()

    async def append_batch(self, session_id: str, messages: list[ConversationMessage]) -> None:
        lock = await self._get_lock(session_id)
        async with lock:
            ctx = self._store.get(session_id)
            if ctx is None:
                ctx = ConversationContext(session_id=session_id)
                self._store[session_id] = ctx
            ctx.messages.extend(messages)
            ctx.touch()

    async def delete(self, session_id: str) -> bool:
        lock = await self._get_lock(session_id)
        async with lock:
            existed = session_id in self._store
            self._store.pop(session_id, None)
            self._cleanup_lock(session_id)
            return existed

    async def exists(self, session_id: str) -> bool:
        lock = await self._get_lock(session_id)
        async with lock:
            ctx = self._store.get(session_id)
            if ctx is None:
                return False
            if self._is_expired(ctx):
                await self._evict(session_id)
                return False
            return True

    async def session_count(self) -> int:
        return len(self._store)

    async def cleanup_expired(self, ttl_seconds: float) -> int:
        removed = 0
        now = time.time()
        async with self._global_lock:
            expired_ids = [
                sid
                for sid, ctx in self._store.items()
                if now - ctx.updated_at > ttl_seconds
            ]
        for sid in expired_ids:
            lock = await self._get_lock(sid)
            async with lock:
                if sid in self._store and self._is_expired(self._store[sid], ttl_seconds):
                    self._store.pop(sid, None)
                    self._cleanup_lock(sid)
                    removed += 1
        if removed:
            logger.info("cleanup_expired removed={} sessions", removed)
        return removed

    # ------------------------------------------------------------------
    # internal helpers
    # ------------------------------------------------------------------

    def _is_expired(self, ctx: ConversationContext, ttl: float | None = None) -> bool:
        if ttl is None:
            ttl = self._config.ttl_seconds
        if ttl <= 0:
            return False
        return time.time() - ctx.updated_at > ttl

    async def _evict(self, session_id: str) -> None:
        self._store.pop(session_id, None)
        self._cleanup_lock(session_id)

    async def _evict_lru(self) -> None:
        """Remove the least-recently-used session."""
        if not self._store:
            return
        lru_id = min(self._store, key=lambda sid: self._store[sid].updated_at)
        lock = await self._get_lock(lru_id)
        async with lock:
            self._store.pop(lru_id, None)
            self._cleanup_lock(lru_id)
        logger.info("evicted LRU session={}", lru_id)
