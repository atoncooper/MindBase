"""Per-session lifecycle management.

Manages sessions across all agents — creation, heartbeat, concurrency locks,
and cleanup of expired sessions.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class SessionState:
    """Runtime state for a single session."""

    session_id: str
    created_at: float = field(default_factory=time.monotonic)
    last_active: float = field(default_factory=time.monotonic)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    meta: dict = field(default_factory=dict)


class SessionManager:
    """Manages session lifecycle — creation, heartbeat, locks, cleanup.

    Usage::

        sm = SessionManager()
        async with sm.acquire_lock("session-1"):
            result = await agent.invoke(...)
            sm.touch("session-1")

        await sm.cleanup_expired(ttl=300)
    """

    def __init__(self) -> None:
        self._sessions: dict[str, SessionState] = {}

    # ── public API ────────────────────────────────────────────────────

    def get_or_create(self, session_id: str) -> SessionState:
        """Return existing session or create a new one."""
        if session_id not in self._sessions:
            self._sessions[session_id] = SessionState(session_id=session_id)
            logger.debug("[SESSION] created %s", session_id)
        return self._sessions[session_id]

    def touch(self, session_id: str) -> None:
        """Refresh the heartbeat timestamp for a session."""
        state = self._sessions.get(session_id)
        if state:
            state.last_active = time.monotonic()

    def acquire_lock(self, session_id: str) -> asyncio.Lock:
        """Get the per-session ``asyncio.Lock`` for concurrency control.

        Usage::

            async with sm.acquire_lock(sid):
                ...
        """
        return self.get_or_create(session_id).lock

    def is_expired(self, session_id: str, ttl_seconds: float) -> bool:
        """Check whether the session has been idle longer than *ttl_seconds*."""
        state = self._sessions.get(session_id)
        if not state:
            return True
        return (time.monotonic() - state.last_active) > ttl_seconds

    async def cleanup_expired(self, ttl_seconds: float = 300.0) -> int:
        """Destroy all sessions idle longer than *ttl_seconds*.

        Returns the number of sessions cleaned up.
        """
        expired = [
            sid
            for sid, state in self._sessions.items()
            if (time.monotonic() - state.last_active) > ttl_seconds
        ]
        for sid in expired:
            self.destroy(sid)
        if expired:
            logger.info("[SESSION] cleaned %s expired sessions", len(expired))
        return len(expired)

    def destroy(self, session_id: str) -> None:
        """Destroy a specific session and release its resources."""
        self._sessions.pop(session_id, None)
        logger.debug("[SESSION] destroyed %s", session_id)

    def destroy_all(self) -> int:
        """Destroy every tracked session — used during shutdown."""
        count = len(self._sessions)
        self._sessions.clear()
        if count:
            logger.info("[SESSION] destroyed all %s sessions", count)
        return count

    @property
    def active_count(self) -> int:
        return len(self._sessions)

    @property
    def active_session_ids(self) -> list[str]:
        return list(self._sessions.keys())
