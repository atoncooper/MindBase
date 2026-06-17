"""ToolManager — discovery, instantiation, and observability of tools.

Workflow:

1. Tool classes are decorated with ``@register_tool`` in their own modules.
2. At startup the harness builds a ``ToolDeps`` and constructs ``ToolManager``.
3. ``manager.discover()`` walks ``app/tools/**`` so every decorator runs,
   then invokes each registered class's ``from_deps(deps)`` factory.
4. The outcome of every factory call (``loaded`` / ``skipped`` / ``failed``)
   is stored as a ``ToolLoadRecord``.  Failures are logged but never abort
   discovery — other tools continue to load.

Observability:

* ``manager.report()``     — multi-line human report for startup logs.
* ``manager.summary()``    — small dict for ``/health`` endpoints.
* ``manager.failed()``     — list of failure records for tests / asserts.

Idempotency:

The decorator is safe to import multiple times (pytest re-import,
hot-reload).  Each class is recorded only once by ``cls.__qualname__``.
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from dataclasses import dataclass
from typing import Any, Callable, Literal, Optional

from app.tools._deps import ToolDeps

logger = logging.getLogger(__name__)


ToolStatus = Literal["loaded", "skipped", "failed"]


@dataclass(frozen=True)
class ToolLoadRecord:
    """Outcome of one ``cls.from_deps(deps)`` call.

    * ``loaded``  — factory returned a tool instance, registered.
    * ``skipped`` — factory returned ``None`` (optional dep missing).
    * ``failed``  — factory raised; reason captures the exception message.
    """

    name: str
    status: ToolStatus
    module: str
    reason: Optional[str] = None
    error_type: Optional[str] = None


# ── decorator registry ────────────────────────────────────────────────────

# Module-level registry. Populated by import side effects.
_REGISTERED_CLASSES: list[type] = []
_REGISTERED_QUALNAMES: set[str] = set()


def register_tool(cls: type) -> type:
    """Class decorator that adds *cls* to the global tool registry.

    The decorated class MUST expose a classmethod ``from_deps(deps)`` that
    returns either an instance of the tool or ``None`` to opt out.

    Idempotent: re-importing the module won't double-register.
    """

    qualname = f"{cls.__module__}.{cls.__qualname__}"
    if qualname in _REGISTERED_QUALNAMES:
        return cls
    if not hasattr(cls, "from_deps"):
        raise TypeError(
            f"@register_tool requires {cls.__qualname__} to define "
            "a classmethod `from_deps(deps: ToolDeps) -> cls | None`"
        )
    _REGISTERED_QUALNAMES.add(qualname)
    _REGISTERED_CLASSES.append(cls)
    return cls


def _iter_registered_classes() -> list[type]:
    """Snapshot of currently registered tool classes."""
    return list(_REGISTERED_CLASSES)


# ── module discovery ──────────────────────────────────────────────────────


def _import_all_tool_modules(package_name: str = "app.tools") -> list[str]:
    """Import every submodule under *package_name* recursively.

    Imports trigger ``@register_tool`` side effects.  Modules whose import
    raises are logged and skipped — discovery does not abort.

    Returns the list of fully-qualified module names that were attempted.
    """

    pkg = importlib.import_module(package_name)
    pkg_path = getattr(pkg, "__path__", None)
    if pkg_path is None:
        return []

    attempted: list[str] = []
    for module_info in pkgutil.walk_packages(pkg_path, prefix=f"{package_name}."):
        name = module_info.name
        # Skip private bookkeeping modules to avoid self-import loops.
        last = name.rsplit(".", 1)[-1]
        if last.startswith("_"):
            continue
        attempted.append(name)
        try:
            importlib.import_module(name)
        except Exception:
            logger.exception("[TOOLS] failed to import %s during discovery", name)
    return attempted


# ── manager ───────────────────────────────────────────────────────────────


class ToolManager:
    """Stateful manager that owns tool discovery and load records.

    Construct once per harness, call ``discover()`` once at startup, then
    read ``tools`` / ``records`` / ``summary()`` as needed.
    """

    def __init__(
        self,
        deps: ToolDeps,
        *,
        package_name: str = "app.tools",
        class_provider: Callable[[], list[type]] = _iter_registered_classes,
    ) -> None:
        self._deps = deps
        self._package_name = package_name
        self._class_provider = class_provider
        self._records: list[ToolLoadRecord] = []
        self._tools: list[Any] = []
        self._discovered = False

    # ── discovery ────────────────────────────────────────────────────────

    def discover(self) -> None:
        """Walk the tool package, then run every registered factory.

        Safe to call only once per manager instance — subsequent calls
        reset state and re-run discovery.
        """

        self._records = []
        self._tools = []

        _import_all_tool_modules(self._package_name)

        for cls in self._class_provider():
            self._try_load(cls)

        self._discovered = True

    def _try_load(self, cls: type) -> None:
        name = cls.__qualname__
        module = cls.__module__
        try:
            tool = cls.from_deps(self._deps)
        except Exception as exc:
            self._records.append(
                ToolLoadRecord(
                    name=name,
                    status="failed",
                    module=module,
                    reason=str(exc) or repr(exc),
                    error_type=type(exc).__name__,
                )
            )
            logger.exception("[TOOLS] %s.from_deps raised", name)
            return

        if tool is None:
            self._records.append(
                ToolLoadRecord(
                    name=name,
                    status="skipped",
                    module=module,
                    reason="from_deps returned None (optional dep missing)",
                )
            )
            return

        # Use the tool's own .name property when available; fall back to qualname.
        tool_name = getattr(tool, "name", name)
        self._tools.append(tool)
        self._records.append(
            ToolLoadRecord(
                name=tool_name,
                status="loaded",
                module=module,
            )
        )

    # ── queries ──────────────────────────────────────────────────────────

    @property
    def tools(self) -> list[Any]:
        """Successfully instantiated tool instances."""
        return list(self._tools)

    @property
    def records(self) -> list[ToolLoadRecord]:
        """All load attempts, regardless of status."""
        return list(self._records)

    @property
    def discovered(self) -> bool:
        return self._discovered

    def loaded(self) -> list[ToolLoadRecord]:
        return [r for r in self._records if r.status == "loaded"]

    def skipped(self) -> list[ToolLoadRecord]:
        return [r for r in self._records if r.status == "skipped"]

    def failed(self) -> list[ToolLoadRecord]:
        return [r for r in self._records if r.status == "failed"]

    # ── observability ────────────────────────────────────────────────────

    def summary(self) -> dict[str, Any]:
        """Small dict suitable for inclusion in ``/health`` payloads."""
        return {
            "total": len(self._records),
            "loaded": len(self.loaded()),
            "skipped": len(self.skipped()),
            "failed": len(self.failed()),
            "failed_tools": [r.name for r in self.failed()],
            "skipped_tools": [r.name for r in self.skipped()],
        }

    def report(self) -> str:
        """Multi-line human-readable startup report."""
        if not self._discovered:
            return "[TOOLS] discovery not run"

        tag = {"loaded": "OK ", "skipped": "SKIP", "failed": "FAIL"}
        lines = [f"[TOOLS] discovery: {self.summary()}"]
        for r in self._records:
            line = f"  {tag[r.status]} {r.name:30s} ({r.module})"
            if r.reason:
                line += f"  -- {r.reason}"
            lines.append(line)
        return "\n".join(lines)
