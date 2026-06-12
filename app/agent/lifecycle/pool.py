"""Agent instance pool.

Manages compiled agent instances per (agent_type, session_id) pair.
This avoids re-compiling LangGraph graphs on every invocation.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


class AgentPool:
    """Pool of compiled agent graph instances.

    Each (agent_type, session_id) pair gets its own compiled graph instance.
    The pool does **not** know what agents do — it simply caches them.

    Usage::

        pool = AgentPool()
        agent = pool.acquire("memory", "session-1", factory)
        result = await agent.ainvoke(...)
        # agent stays cached for reuse
        agent = pool.acquire("memory", "session-1", factory)  # same instance
    """

    def __init__(self) -> None:
        # {(agent_type, session_id): compiled_graph}
        self._instances: dict[tuple[str, str], Any] = {}

    def acquire(self, agent_type: str, session_id: str, factory: callable) -> Any:
        """Get a cached agent instance or create one via *factory*."""
        key = (agent_type, session_id)
        if key not in self._instances:
            self._instances[key] = factory()
            logger.debug("[POOL] created %s/%s", agent_type, session_id)
        return self._instances[key]

    def release(self, agent_type: str, session_id: str) -> None:
        """Remove a specific agent instance from the pool."""
        key = (agent_type, session_id)
        self._instances.pop(key, None)
        logger.debug("[POOL] released %s/%s", agent_type, session_id)

    def release_session(self, session_id: str) -> int:
        """Release all agent instances for a given session."""
        keys = [k for k in self._instances if k[1] == session_id]
        for k in keys:
            self._instances.pop(k, None)
        if keys:
            logger.debug(
                "[POOL] released session %s (%s agents)", session_id, len(keys)
            )
        return len(keys)

    def release_all(self) -> int:
        """Release every cached instance — used during shutdown."""
        count = len(self._instances)
        self._instances.clear()
        if count:
            logger.info("[POOL] released all %s instances", count)
        return count

    @property
    def size(self) -> int:
        return len(self._instances)
