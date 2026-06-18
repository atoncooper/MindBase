"""Framework-agnostic tool layer.

``app/tools/`` defines tools as plain classes implementing the ``BaseTool``
protocol — no LangChain or LangGraph dependency.

These tools are registered in a ``ToolRegistry`` and executed by the
``AgentRuntime`` (in ``app/harness/``).  Agents never call tools directly.

Discovery
---------
Tools self-register via ``@register_tool``.  At startup the harness
constructs a :class:`ToolManager` with a :class:`ToolDeps` container and
calls ``discover()``; the manager imports every submodule under
``app.tools`` (triggering decorators) and runs each class's
``from_deps`` factory.  See :mod:`app.tools._manager` for details.
"""

from ._deps import ToolDeps
from ._manager import ToolLoadRecord, ToolManager, register_tool
from .base import BaseTool
from .registry import ToolRegistry

__all__ = [
    "BaseTool",
    "ToolDeps",
    "ToolLoadRecord",
    "ToolManager",
    "ToolRegistry",
    "register_tool",
]
