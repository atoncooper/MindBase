"""ContextManager — the main orchestrator for conversation context."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING

from .config import ContextConfig, DEFAULT_CONFIG
from .models import ConversationMessage
from .store import ConversationStore, InMemoryStore
from .window import SlidingTurnWindow, WindowStrategy

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)


class ContextManager:
    """Manages conversation context per chat_session_id.

    Lifecycle:
        - Created once at application startup (singleton).
        - Injected into routers/services via FastAPI Depends().

    Thread safety:
        All methods are async-safe. The underlying InMemoryStore
        uses per-session asyncio.Lock.

    Usage::

        ctx = await manager.get_context(chat_session_id)
        # ... build LLM messages with ctx ...
        await manager.add_turn(chat_session_id, user_msg, assistant_msg)
    """

    def __init__(
        self,
        store: ConversationStore | None = None,
        window: WindowStrategy | None = None,
        config: ContextConfig | None = None,
    ) -> None:
        self._config = config or DEFAULT_CONFIG
        self._store = store or InMemoryStore(self._config)
        self._window = window or SlidingTurnWindow(self._config.max_turns)
        self._cleanup_task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------

    async def get_context(self, session_id: str) -> list[ConversationMessage]:
        """Return the trimmed message list for a session.

        If the session doesn't exist, returns an empty list.
        The returned list is already trimmed by the window strategy.
        """
        ctx = await self._store.load(session_id)
        if ctx is None:
            return []
        return self._window.apply(ctx.messages)

    async def get_context_raw(self, session_id: str) -> list[ConversationMessage]:
        """Return ALL messages without window trimming (for debugging)."""
        ctx = await self._store.load(session_id)
        if ctx is None:
            return []
        return list(ctx.messages)

    async def add_message(self, session_id: str, message: ConversationMessage) -> None:
        """Append a single message to the session context."""
        await self._store.append(session_id, message)
        await self._invalidate_cache(session_id)

    async def add_user_message(self, session_id: str, content: str) -> None:
        """Shorthand for appending a user message."""
        await self.add_message(
            session_id, ConversationMessage(role="user", content=content)
        )

    async def add_assistant_message(self, session_id: str, content: str) -> None:
        """Shorthand for appending an assistant message."""
        await self.add_message(
            session_id, ConversationMessage(role="assistant", content=content)
        )

    async def add_turn(
        self, session_id: str, user_content: str, assistant_content: str
    ) -> None:
        """Atomically append a complete user+assistant turn.

        Both messages share the same timestamp for ordering consistency
        and are written in a single lock acquisition via append_batch.
        """
        ts = time.time()
        user_msg = ConversationMessage(role="user", content=user_content, timestamp=ts)
        assistant_msg = ConversationMessage(
            role="assistant", content=assistant_content, timestamp=ts
        )
        await self._store.append_batch(session_id, [user_msg, assistant_msg])
        await self._invalidate_cache(session_id)

    async def replace_all(
        self, session_id: str, messages: list[ConversationMessage]
    ) -> None:
        """Replace the entire context for a session (e.g. after summarization)."""
        from .models import ConversationContext

        ctx = ConversationContext(
            session_id=session_id,
            messages=list(messages),
        )
        await self._store.save(session_id, ctx)

    async def clear(self, session_id: str) -> bool:
        """Remove all context for a session. Returns True if it existed."""
        result = await self._store.delete(session_id)
        if result:
            await self._invalidate_cache(session_id)
        return result

    async def exists(self, session_id: str) -> bool:
        """Check if a session has stored context."""
        return await self._store.exists(session_id)

    async def turn_count(self, session_id: str) -> int:
        """Return the number of complete turns for a session."""
        ctx = await self._store.load(session_id)
        if ctx is None:
            return 0
        return ctx.turn_count

    async def message_count(self, session_id: str) -> int:
        """Return the total number of stored messages for a session."""
        ctx = await self._store.load(session_id)
        if ctx is None:
            return 0
        return len(ctx.messages)

    async def session_count(self) -> int:
        """Return the total number of active sessions in the store."""
        return await self._store.session_count()

    @staticmethod
    async def _invalidate_cache(session_id: str) -> None:
        """Invalidate the Redis compressed-summary cache for *session_id*."""
        try:
            from .cache import invalidate as _invalidate

            await _invalidate(session_id)
        except Exception:
            pass  # best-effort, never block the caller

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------

    async def start_cleanup(self) -> None:
        """Start a background task that periodically evicts expired sessions."""
        if self._config.cleanup_interval <= 0 or self._config.ttl_seconds <= 0:
            return

        async def _loop() -> None:
            while True:
                await asyncio.sleep(self._config.cleanup_interval)
                try:
                    removed = await self._store.cleanup_expired(
                        self._config.ttl_seconds
                    )
                    if removed:
                        logger.debug("background cleanup: removed=%s sessions", removed)
                except Exception:
                    logger.exception("background cleanup failed")

        self._cleanup_task = asyncio.create_task(_loop())
        logger.info(
            "cleanup task started interval=%ss ttl=%ss",
            self._config.cleanup_interval,
            self._config.ttl_seconds,
        )

    async def stop_cleanup(self) -> None:
        """Cancel the background cleanup task."""
        if self._cleanup_task is not None:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None

    # ------------------------------------------------------------------
    # introspection
    # ------------------------------------------------------------------

    @property
    def config(self) -> ContextConfig:
        return self._config

    @property
    def window(self) -> WindowStrategy:
        return self._window

    @property
    def store(self) -> ConversationStore:
        return self._store
