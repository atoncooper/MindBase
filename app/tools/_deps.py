"""ToolDeps — frozen container of every dependency a tool *might* need.

The harness builds a single ``ToolDeps`` instance at startup and hands it
to ``ToolManager``.  Each tool's ``from_deps(deps)`` classmethod picks the
fields it needs.  Optional fields default to ``None`` so a tool can decide
to skip itself (return ``None`` from ``from_deps``) when its dependency is
unavailable in the current deployment.

Adding a new dependency is purely additive — existing tools that don't
read the new field are unaffected.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ToolDeps:
    """Container of dependencies that any registered tool may consume.

    Fields are intentionally typed as ``Any`` to keep this module free of
    heavy imports.  Tools cast / annotate as needed in their own factories.
    """

    rag: Any = None
    ctx_mgr: Any = None
    llm: Any = None
    db_deps: Any = None
    lifecycle: Any = None
    skill_manager: Any = None
