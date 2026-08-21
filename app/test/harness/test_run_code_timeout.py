"""Tests for RunCodeTool timeout + sandbox lifecycle.

Verifies that run_code enforces a per-step timeout and always deletes the
Daytona sandbox (even on timeout/failure), fixing the sandbox-leak window.
"""

import time
from unittest.mock import MagicMock

import pytest

from app.tools.code import run_code as run_code_module
from app.tools.code.run_code import RunCodeTool

pytestmark = pytest.mark.asyncio


def _make_tool(daytona: MagicMock) -> RunCodeTool:
    """Build a RunCodeTool with a mocked Daytona client (bypasses __init__)."""
    tool = RunCodeTool.__new__(RunCodeTool)
    tool._daytona = daytona
    tool._network_block_all = True
    tool._domain_allow_list = ""
    return tool


class TestRunCodeSandboxLifecycle:
    async def test_normal_execution(self):
        from types import SimpleNamespace

        daytona = MagicMock()
        sandbox = MagicMock()
        # Use SimpleNamespace (not MagicMock) so unset attrs like `exitCode`
        # return None via getattr, matching the real SDK response shape.
        sandbox.process.code_run.return_value = SimpleNamespace(result="hello", exit_code=0)
        daytona.create.return_value = sandbox

        tool = _make_tool(daytona)
        result = await tool.run(code="print('hello')", language="python")

        assert "hello" in result["content"]
        assert result["exit_code"] == 0
        daytona.create.assert_called_once()
        daytona.delete.assert_called_once_with(sandbox)

    async def test_create_failure_returns_error_without_delete(self):
        daytona = MagicMock()
        daytona.create.side_effect = RuntimeError("no quota")

        tool = _make_tool(daytona)
        result = await tool.run(code="x", language="python")

        assert "沙箱创建失败" in result["content"]
        assert result["exit_code"] == -1
        # No sandbox was created, so delete must not be called.
        daytona.delete.assert_not_called()

    async def test_run_failure_still_deletes_sandbox(self):
        daytona = MagicMock()
        sandbox = MagicMock()
        sandbox.process.code_run.side_effect = RuntimeError("syntax error")
        daytona.create.return_value = sandbox

        tool = _make_tool(daytona)
        result = await tool.run(code="bad code", language="python")

        assert "运行失败" in result["content"]
        # Sandbox was created, so it must still be deleted.
        daytona.delete.assert_called_once_with(sandbox)

    async def test_unsupported_language_still_deletes(self):
        daytona = MagicMock()
        sandbox = MagicMock()
        daytona.create.return_value = sandbox

        tool = _make_tool(daytona)
        result = await tool.run(code="x", language="rust")

        assert "不支持的语言" in result["content"]
        daytona.delete.assert_called_once_with(sandbox)

    async def test_allow_list_takes_precedence_over_block_all(self):
        # When both network_block_all=True and domain_allow_list are set, the
        # SDK rejects the combo. The allow-list alone already restricts to the
        # listed domains, so it must win and network_block_all must NOT be
        # passed (no fallback to an unconstrained sandbox).
        from types import SimpleNamespace

        daytona = MagicMock()
        sandbox = MagicMock()
        sandbox.process.code_run.return_value = SimpleNamespace(result="ok", exit_code=0)
        daytona.create.return_value = sandbox

        tool = RunCodeTool.__new__(RunCodeTool)
        tool._daytona = daytona
        tool._network_block_all = True
        tool._domain_allow_list = "*.pypi.org,github.com"

        await tool.run(code="print(1)", language="python")

        # create called once with structured params (no fallback retry).
        assert daytona.create.call_count == 1
        params = daytona.create.call_args.args[0]
        assert getattr(params, "domain_allow_list", None) == "*.pypi.org,github.com"
        # network_block_all must NOT be set (would trip the SDK guard).
        assert not getattr(params, "network_block_all", None)


class TestRunCodeTimeout:
    async def test_timeout_returns_and_deletes_sandbox(self, monkeypatch):
        # Use a short timeout so the test is fast; the run sleeps longer.
        monkeypatch.setattr(run_code_module, "RUN_CODE_TIMEOUT", 0.3)

        daytona = MagicMock()
        sandbox = MagicMock()

        def slow_run(code):  # noqa: ARG001
            time.sleep(1.0)  # longer than the patched timeout
            return MagicMock(result="done")

        sandbox.process.code_run = slow_run
        daytona.create.return_value = sandbox

        tool = _make_tool(daytona)
        result = await tool.run(code="while True: pass", language="python")

        assert result.get("timeout") is True
        assert result["exit_code"] == -1
        # Crucially, the sandbox is still deleted despite the timeout.
        daytona.delete.assert_called_once_with(sandbox)
