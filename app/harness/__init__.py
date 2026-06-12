"""Agent Harness — integration layer that wires agents into the application.

The harness creates ``ToolRegistry``, ``AgentRuntime``, registers all
tools and agents, and provides a single ``invoke()`` entry point.

Usage in ``main.py``::

    from app.harness import AgentHarness
    from app.context import init_context_manager
    from langchain_openai import ChatOpenAI

    harness = AgentHarness(
        context_manager=init_context_manager(),
        llm=ChatOpenAI(model="gpt-4o-mini", temperature=0),
    )
    await harness.start()
    app.state.agent_harness = harness

    # On shutdown:
    await harness.shutdown()
"""

from .app import AgentHarness
from .orchestrator import AgentOrchestrator
from .runtime import AgentRuntime

__all__ = ["AgentHarness", "AgentOrchestrator", "AgentRuntime"]
