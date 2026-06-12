"""Agent orchestration layer.

``AgentLifecycleManager`` is the single entry point for all agent types.
See ``app/agent/lifecycle/`` for the lifecycle components and
``app/agent/memory/`` for the memory/context-retrieval agent.

Quick start::

    from app.agent.lifecycle import AgentLifecycleManager
    from app.agent.memory import build_memory_agent

    manager = AgentLifecycleManager()
    manager.register("memory", build_memory_agent, context_manager=..., llm=...)
    result = await manager.invoke("memory", session_id="abc", query="...")
"""

from .lifecycle import AgentLifecycleManager

__all__ = [
    "AgentLifecycleManager",
]
