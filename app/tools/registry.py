"""ToolRegistry — central registry for all tools.

Tools are framework-agnostic ``BaseTool`` instances.  The registry provides:

* Registration and lookup.
* ``for_agent()`` — returns LangChain-compatible tool definitions for ``bind_tools()``.
"""

from __future__ import annotations

import logging
from typing import Any

from langchain_core.tools import StructuredTool
from pydantic import create_model

logger = logging.getLogger(__name__)


class ToolRegistry:
    """Central registry for ``BaseTool`` instances.

    Usage::

        registry = ToolRegistry()
        registry.register(SearchChatHistoryTool(ctx_mgr))
        registry.register(GetRecentContextTool(ctx_mgr))

        for_defs = registry.for_agent()   # → list of StructuredTool
    """

    def __init__(self) -> None:
        self._tools: dict[str, Any] = {}  # name → tool instance

    # ── registration ──────────────────────────────────────────────────

    def register(self, tool: Any) -> None:
        """Register a tool instance (must match ``BaseTool`` protocol)."""
        name = tool.name
        if name in self._tools:
            logger.warning("[TOOL_REGISTRY] overwriting tool '%s'", name)
        self._tools[name] = tool
        logger.info("[TOOL_REGISTRY] registered tool '%s'", name)

    def unregister(self, name: str) -> bool:
        """Remove a tool by name.  Returns True if it existed."""
        if name in self._tools:
            del self._tools[name]
            logger.info("[TOOL_REGISTRY] unregistered tool '%s'", name)
            return True
        return False

    # ── lookup ────────────────────────────────────────────────────────

    def get(self, name: str) -> Any:
        """Look up a tool by name.  Raises ``KeyError`` if missing."""
        if name not in self._tools:
            raise KeyError(f"tool '{name}' not registered")
        return self._tools[name]

    def list(self) -> list[str]:
        """Return all registered tool names."""
        return list(self._tools.keys())

    # ── bridge ────────────────────────────────────────────────────────

    def for_agent(self) -> list[StructuredTool]:
        """Return LangChain-compatible tool list for ``llm.bind_tools()``.

        Each tool is wrapped in a ``StructuredTool`` so the LLM can see its
        name, description, and parameter schema — but the LLM never actually
        executes them (the ``AgentRuntime`` does).
        """
        result: list[StructuredTool] = []
        for name, tool in self._tools.items():
            try:
                params = tool.parameters()
                args_schema = _build_args_schema(name, params)
                st = StructuredTool(
                    name=name,
                    description=tool.description,
                    args_schema=args_schema,
                    coroutine=self._make_stub(name),
                )
                result.append(st)
            except Exception:
                logger.exception("[TOOL_REGISTRY] failed to build def for '%s'", name)
        return result

    def _make_stub(self, name: str) -> callable:
        """Create a closure that captures *name* by value (avoids late-binding bug)."""

        async def stub(**kwargs: Any) -> str:
            return await self._stub(name, kwargs)

        return stub

    async def _stub(self, name: str, kwargs: dict) -> str:
        """Stub coroutine — should never be called by the LLM directly."""
        raise RuntimeError(
            f"tool '{name}' should not be called directly. "
            "Use AgentRuntime.execute() instead."
        )


# ── helpers ────────────────────────────────────────────────────────────

_JSON_TYPE_MAP = {
    "string": (str, ...),
    "integer": (int, ...),
    "number": (float, ...),
    "boolean": (bool, ...),
    "array": (list, ...),
    "object": (dict, ...),
    "null": (type(None), None),
}


def _build_args_schema(tool_name: str, params: dict) -> type:
    """Convert a JSON Schema parameters dict to a Pydantic model.

    Each property becomes a field with type + description.
    Non-required properties get ``Optional`` with ``None`` default.
    """
    properties = params.get("properties", {})
    required_set = set(params.get("required", []))

    fields: dict[str, tuple] = {}
    for prop_name, prop_schema in properties.items():
        json_type = prop_schema.get("type", "string")
        py_type, _ = _JSON_TYPE_MAP.get(json_type, (str, ...))

        field_desc = prop_schema.get("description", "")
        default = ... if prop_name in required_set else None

        from pydantic import Field

        fields[prop_name] = (py_type, Field(default=default, description=field_desc))

    return create_model(f"{tool_name}Args", **fields)
