"""Observability hooks for agent lifecycle events.

Agents register callbacks for lifecycle events.  This is how you add
metrics, tracing, logging, or audit trails without touching agent code.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable

logger = logging.getLogger(__name__)

# ── hook type aliases ─────────────────────────────────────────────────

HookFn = Callable[..., None]


class LifecycleHookRegistry:
    """Registry of lifecycle callbacks, grouped by event name.

    Predefined events::

        on_invoke_start     → fn(session_id, agent_name, input)
        on_invoke_end       → fn(session_id, agent_name, duration_ms)
        on_invoke_error     → fn(session_id, agent_name, error)
        on_session_created  → fn(session_id)
        on_session_expired  → fn(session_id)
        on_agent_start      → fn(agent_name)
        on_agent_shutdown   → fn(agent_name)

    Custom events are allowed — just call ``emit()`` with any name.
    """

    def __init__(self) -> None:
        self._hooks: dict[str, list[HookFn]] = {}

    # ── registration ──────────────────────────────────────────────────

    def on(self, event: str, fn: HookFn) -> None:
        """Register a callback for *event*."""
        self._hooks.setdefault(event, []).append(fn)

    def off(self, event: str, fn: HookFn) -> None:
        """Remove a specific callback from *event*."""
        if event in self._hooks:
            self._hooks[event] = [h for h in self._hooks[event] if h is not fn]

    # ── emitting ──────────────────────────────────────────────────────

    def emit(self, event: str, **kwargs: Any) -> None:
        """Fire all callbacks registered for *event*."""
        for fn in self._hooks.get(event, []):
            try:
                fn(**kwargs)
            except Exception as exc:
                logger.warning("[HOOK] {} callback failed: {}", event, exc)

    # ── convenience emitters ──────────────────────────────────────────

    def on_invoke_start(self, session_id: str, agent_name: str, **input: Any) -> None:
        self.emit("on_invoke_start", session_id=session_id, agent_name=agent_name, input=input)

    def on_invoke_end(self, session_id: str, agent_name: str, duration_ms: float) -> None:
        self.emit("on_invoke_end", session_id=session_id, agent_name=agent_name, duration_ms=duration_ms)

    def on_invoke_error(self, session_id: str, agent_name: str, error: str) -> None:
        self.emit("on_invoke_error", session_id=session_id, agent_name=agent_name, error=error)

    def on_session_created(self, session_id: str) -> None:
        self.emit("on_session_created", session_id=session_id)

    def on_session_expired(self, session_id: str) -> None:
        self.emit("on_session_expired", session_id=session_id)
