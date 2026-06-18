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

    async def run(self, **kwargs: Any) -> Any:
        """Execute the tool.

        Returns either:

        * A plain string — used as ``ToolMessage.content``.
        * A dict ``{"content": str, **extras}`` — ``content`` becomes the
          ``ToolMessage.content`` (visible to the LLM) and the remaining
          keys are placed in ``ToolMessage.additional_kwargs`` so graph
          nodes can read structured payloads (e.g. retrieval sources)
          without re-parsing the text.
        """
        ...
