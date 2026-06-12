"""FastAPI dependency injection for ContextManager."""

from __future__ import annotations

from typing import Optional

from fastapi import Request

from .config import ContextConfig
from .manager import ContextManager

# Module-level singleton reference.
# Initialized once during app startup, cleared for testing.
_context_manager: ContextManager | None = None


def init_context_manager(config: ContextConfig | None = None) -> ContextManager:
    """Create (or return the existing) ContextManager singleton.

    Call once during FastAPI startup, *before* the app begins serving.
    Subsequent calls return the same instance unless reset is called.
    """
    global _context_manager
    if _context_manager is None:
        _context_manager = ContextManager(config=config)
    return _context_manager


async def get_context_manager(request: Request) -> ContextManager:
    """FastAPI dependency — retrieves ContextManager from app state."""
    manager = getattr(request.app.state, "context_manager", None)
    if manager is None:
        # Lazy fallback: create with defaults (should not happen if
        # init_context_manager was called during startup).
        manager = init_context_manager()
        request.app.state.context_manager = manager
    return manager


def reset_context_manager() -> None:
    """Reset the singleton. Intended for test teardown."""
    global _context_manager
    _context_manager = None
