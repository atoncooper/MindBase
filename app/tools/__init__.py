"""Framework-agnostic tool layer.

``app/tools/`` defines tools as plain classes implementing the ``BaseTool``
protocol — no LangChain or LangGraph dependency.

These tools are registered in a ``ToolRegistry`` and executed by the
``AgentRuntime`` (in ``app/harness/``).  Agents never call tools directly.
"""

from .base import BaseTool
from .registry import ToolRegistry

__all__ = [
    "BaseTool",
    "ToolRegistry",
]
