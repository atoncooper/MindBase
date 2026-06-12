"""BaseTool protocol — framework-agnostic tool interface.

Any class implementing this protocol can be registered with ``ToolRegistry``
and used by any agent framework (LangGraph, custom, etc.).
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class BaseTool(Protocol):
    """Protocol for a framework-agnostic tool.

    Implementing classes must provide:

    * ``name`` / ``description`` — metadata for LLM visibility.
    * ``parameters()`` — JSON Schema dict for argument validation.
    * ``run(**kwargs)`` — the actual tool logic.
    """

    @property
    def name(self) -> str: ...

    @property
    def description(self) -> str: ...

    def parameters(self) -> dict[str, Any]:
        """Return JSON Schema describing this tool's parameters."""
        ...

    async def run(self, **kwargs: Any) -> str:
        """Execute the tool and return a text result."""
        ...
