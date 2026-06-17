"""Unit tests for ``app.tools._manager``.

Validates:
- decorator idempotency
- factory return-value handling (instance / None / raise)
- ``ToolManager`` records and summary semantics
- ``register_tool`` rejects classes without ``from_deps``
"""

from __future__ import annotations

import pytest

from app.tools._manager import (
    ToolLoadRecord,
    ToolManager,
    _REGISTERED_QUALNAMES,
    register_tool,
)
from app.tools._deps import ToolDeps


# ── helpers ──────────────────────────────────────────────────────────


class _FakeDeps:
    """Stand-in for ToolDeps; the manager only forwards it through."""


def _make_manager(*classes: type) -> ToolManager:
    """Build a ToolManager whose class_provider returns *classes*.

    Bypasses package-walking discovery so tests stay isolated from the
    real ``app.tools.*`` registry.
    """
    deps = ToolDeps()
    return ToolManager(
        deps,
        package_name="app.tools",
        class_provider=lambda: list(classes),
    )


# ── decorator behavior ───────────────────────────────────────────────


def test_register_tool_rejects_class_without_from_deps() -> None:
    with pytest.raises(TypeError, match="from_deps"):

        @register_tool
        class MissingFactory:  # noqa: D401 — fixture
            pass


def test_register_tool_is_idempotent() -> None:
    """Re-decorating the same class must not double-register."""

    class Stable:
        @classmethod
        def from_deps(cls, deps):  # type: ignore[no-untyped-def]
            return cls()

    qualname = f"{Stable.__module__}.{Stable.__qualname__}"
    _REGISTERED_QUALNAMES.discard(qualname)

    register_tool(Stable)
    register_tool(Stable)  # second call should be a no-op

    # Count direct hits in the registry list — qualname dedup means 1.
    from app.tools._manager import _REGISTERED_CLASSES

    matches = [c for c in _REGISTERED_CLASSES if c is Stable]
    assert len(matches) == 1


# ── ToolManager.discover() ───────────────────────────────────────────


def test_loaded_tool_recorded_with_tool_name() -> None:
    class GoodTool:
        name = "good_tool"

        @classmethod
        def from_deps(cls, deps):  # type: ignore[no-untyped-def]
            return cls()

    manager = _make_manager(GoodTool)
    # Skip walking the real package so only GoodTool is considered.
    manager._import_all_tool_modules = lambda *a, **k: []  # type: ignore[assignment]

    # discover() still calls _import_all_tool_modules; patch the helper.
    import app.tools._manager as mod

    original_import = mod._import_all_tool_modules
    mod._import_all_tool_modules = lambda *a, **k: []
    try:
        manager.discover()
    finally:
        mod._import_all_tool_modules = original_import

    assert len(manager.tools) == 1
    assert manager.summary()["loaded"] == 1
    rec = manager.records[0]
    assert rec.status == "loaded"
    assert rec.name == "good_tool"  # uses tool.name, not qualname


def test_skipped_tool_when_factory_returns_none() -> None:
    class OptionalTool:
        @classmethod
        def from_deps(cls, deps):  # type: ignore[no-untyped-def]
            return None

    manager = _make_manager(OptionalTool)
    import app.tools._manager as mod

    original = mod._import_all_tool_modules
    mod._import_all_tool_modules = lambda *a, **k: []
    try:
        manager.discover()
    finally:
        mod._import_all_tool_modules = original

    assert manager.tools == []
    summary = manager.summary()
    assert summary["skipped"] == 1
    assert summary["loaded"] == 0
    assert summary["skipped_tools"][0].endswith("OptionalTool")


def test_failed_tool_when_factory_raises() -> None:
    class BrokenTool:
        @classmethod
        def from_deps(cls, deps):  # type: ignore[no-untyped-def]
            raise RuntimeError("boom")

    manager = _make_manager(BrokenTool)
    import app.tools._manager as mod

    original = mod._import_all_tool_modules
    mod._import_all_tool_modules = lambda *a, **k: []
    try:
        manager.discover()
    finally:
        mod._import_all_tool_modules = original

    assert manager.tools == []
    summary = manager.summary()
    assert summary["failed"] == 1
    assert summary["failed_tools"][0].endswith("BrokenTool")
    rec = manager.failed()[0]
    assert rec.error_type == "RuntimeError"
    assert "boom" in (rec.reason or "")


def test_one_failure_does_not_block_other_tools() -> None:
    class GoodTool:
        name = "good"

        @classmethod
        def from_deps(cls, deps):  # type: ignore[no-untyped-def]
            return cls()

    class BrokenTool:
        @classmethod
        def from_deps(cls, deps):  # type: ignore[no-untyped-def]
            raise ValueError("nope")

    manager = _make_manager(BrokenTool, GoodTool)
    import app.tools._manager as mod

    original = mod._import_all_tool_modules
    mod._import_all_tool_modules = lambda *a, **k: []
    try:
        manager.discover()
    finally:
        mod._import_all_tool_modules = original

    summary = manager.summary()
    assert summary["loaded"] == 1
    assert summary["failed"] == 1
    assert [t.name for t in manager.tools] == ["good"]


def test_report_string_contains_status_tags() -> None:
    class GoodTool:
        name = "g"

        @classmethod
        def from_deps(cls, deps):  # type: ignore[no-untyped-def]
            return cls()

    manager = _make_manager(GoodTool)
    import app.tools._manager as mod

    original = mod._import_all_tool_modules
    mod._import_all_tool_modules = lambda *a, **k: []
    try:
        manager.discover()
    finally:
        mod._import_all_tool_modules = original

    text = manager.report()
    assert "[TOOLS] discovery:" in text
    assert "OK " in text
    assert "g" in text
