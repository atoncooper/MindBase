"""Lifecycle layer — shared by all agents.

This package provides unified lifecycle management for any LangGraph-based
agent in the system.  Agents register themselves with ``AgentLifecycleManager``,
which handles session lifecycle, pooling, concurrency control, observability
hooks, and circuit-breaking — all without knowing what any specific agent does.

Typical usage::

    manager = AgentLifecycleManager()

    # Register agent factories
    manager.register("memory", create_memory_agent_factory(...))

    # Unified invoke — session lifecycle is automatic
    result = await manager.invoke("memory", session_id="abc", query="...")
"""

from .circuit import CircuitBreaker, CircuitState
from .hooks import LifecycleHookRegistry
from .manager import AgentFactory, AgentLifecycleManager
from .pool import AgentPool
from .session import SessionManager

__all__ = [
    "AgentLifecycleManager",
    "AgentFactory",
    "AgentPool",
    "SessionManager",
    "LifecycleHookRegistry",
    "CircuitBreaker",
    "CircuitState",
]
