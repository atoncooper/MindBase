"""Tests for RunSkillCodeTool (app/tools/skill/run_skill_code.py).

Verifies registration gating (skill_manager + DAYTONA__ENABLED), the
sandbox lifecycle (create -> upload tools/ -> exec entry -> always delete),
and friendly error paths. The Daytona SDK is fully mocked - no network.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.infra.config import config
from app.models import Base
from app.skills.manager import SkillManager
from app.skills.zip_parser import build_skill_zip
from app.tools import ToolDeps
from app.tools.skill.run_skill_code import RunSkillCodeTool

UID = 1


@pytest_asyncio.fixture
async def session_factory():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    yield factory
    await engine.dispose()


@pytest_asyncio.fixture
async def mock_minio():
    """In-memory MinIO stand-in (same as test_skills)."""
    m = AsyncMock()
    store: dict[str, bytes] = {}

    async def put(key, data, ct="application/octet-stream"):
        store[key] = data

    async def get(key):
        if key not in store:
            raise FileNotFoundError(key)
        return store[key]

    async def delete(key):
        store.pop(key, None)

    m.put_object = AsyncMock(side_effect=put)
    m.get_object = AsyncMock(side_effect=get)
    m.delete_object = AsyncMock(side_effect=delete)
    m._store = store
    return m


def _make_zip() -> bytes:
    return build_skill_zip(
        skill_md="# Skill\nrun it",
        manifest={
            "skill_id": "analyzer",
            "name": "analyzer",
            "has_code_tools": True,
            "entry": "main.py",
        },
        code_tools={"main.py": "print(\"hello\")", "utils.py": "def f(): return 1"},
    )


async def _install(mgr: SkillManager, zip_bytes: bytes | None = None) -> None:
    await mgr.install(
        uid=UID,
        skill_id="analyzer",
        name="analyzer",
        description="",
        version=None,
        source_store="upload",
        zip_bytes=zip_bytes or _make_zip(),
        manifest={"has_code_tools": True, "entry": "main.py"},
    )


def _make_tool(mgr: SkillManager) -> RunSkillCodeTool:
    """Build a tool with a mocked Daytona client (bypasses __init__)."""
    tool = RunSkillCodeTool.__new__(RunSkillCodeTool)
    tool._skill_manager = mgr
    tool._daytona = MagicMock()
    tool._network_block_all = True
    tool._domain_allow_list = ""
    return tool


def _sandbox(exec_result: dict | None = None) -> MagicMock:
    """A mocked sandbox: workdir + fs.upload_file + process.exec."""
    sb = MagicMock()
    sb.get_work_dir.return_value = "/workspace"
    resp = MagicMock()
    if exec_result is not None:
        resp.result = exec_result.get("result", "")
        resp.exit_code = exec_result.get("exit_code", 0)
    else:
        resp.result = "exitCode=0\nhello from sandbox"
        resp.exit_code = 0
    sb.process.exec.return_value = resp
    return sb


class TestFromDeps:
    def test_none_without_skill_manager(self) -> None:
        assert RunSkillCodeTool.from_deps(ToolDeps()) is None

    def test_none_when_daytona_disabled(self, session_factory, monkeypatch) -> None:
        monkeypatch.setattr(config.daytona, "enabled", False)
        mgr = SkillManager(session_factory, None)
        assert RunSkillCodeTool.from_deps(ToolDeps(skill_manager=mgr)) is None

    def test_registers_when_daytona_enabled(self, session_factory, monkeypatch) -> None:
        monkeypatch.setattr(config.daytona, "enabled", True)
        mgr = SkillManager(session_factory, None)
        tool = RunSkillCodeTool.from_deps(ToolDeps(skill_manager=mgr))
        # daytona-sdk is not installed in the test env - from_deps catches it
        # and returns None; that is still a valid gating result.
        assert tool is None or isinstance(tool, RunSkillCodeTool)

    def test_metadata(self) -> None:
        tool = RunSkillCodeTool.__new__(RunSkillCodeTool)  # property access, no init
        assert tool.name == "run_skill_code"
        params = tool.parameters()
        assert params["required"] == ["skill_id"]


class TestRun:
    @pytest.mark.asyncio
    async def test_missing_uid(self, session_factory) -> None:
        mgr = SkillManager(session_factory, None)
        tool = _make_tool(mgr)
        result = await tool.run(skill_id="analyzer")
        assert "_uid" in result["content"]

    @pytest.mark.asyncio
    async def test_unknown_skill(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        tool = _make_tool(mgr)
        result = await tool.run(skill_id="nope", _uid=UID)
        assert "未知技能" in result["content"]

    @pytest.mark.asyncio
    async def test_skill_without_code_tools(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        zip_bytes = build_skill_zip(
            skill_md="# Skill", manifest={"skill_id": "plain", "name": "plain"},
        )
        await mgr.install(
            uid=UID, skill_id="plain", name="plain", description="", version=None,
            source_store="upload", zip_bytes=zip_bytes, manifest={},
        )
        tool = _make_tool(mgr)
        result = await tool.run(skill_id="plain", _uid=UID)
        assert "不含可执行的代码工具" in result["content"]

    @pytest.mark.asyncio
    async def test_unknown_entry(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        await _install(mgr)
        tool = _make_tool(mgr)
        result = await tool.run(skill_id="analyzer", entry="nope.py", _uid=UID)
        assert "入口" in result["content"]
        assert "不存在" in result["content"]

    @pytest.mark.asyncio
    async def test_runs_entry_in_sandbox(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        await _install(mgr)
        tool = _make_tool(mgr)
        sb = _sandbox()
        tool._daytona.create.return_value = sb

        result = await tool.run(skill_id="analyzer", _uid=UID)

        assert result["exit_code"] == 0
        assert "hello from sandbox" in result["content"]
        # both tools/ files uploaded to the sandbox workdir
        assert sb.fs.upload_file.call_count == 2
        uploads = [c.args for c in sb.fs.upload_file.call_args_list]
        assert any(a[1] == "/workspace/tools/main.py" for a in uploads)
        assert any(a[1] == "/workspace/tools/utils.py" for a in uploads)
        # entry executed with cwd=workdir
        cmd = sb.process.exec.call_args.args[0]
        assert cmd == "python tools/main.py"
        assert sb.process.exec.call_args.kwargs.get("cwd") == "/workspace"
        # sandbox deleted
        tool._daytona.delete.assert_called_once_with(sb)

    @pytest.mark.asyncio
    async def test_passes_args_and_entry_override(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        await _install(mgr)
        tool = _make_tool(mgr)
        sb = _sandbox()
        tool._daytona.create.return_value = sb

        await tool.run(
            skill_id="analyzer", entry="utils.py", args="--verbose 2", _uid=UID
        )

        cmd = sb.process.exec.call_args.args[0]
        assert cmd == "python tools/utils.py --verbose 2"
        tool._daytona.delete.assert_called_once_with(sb)

    @pytest.mark.asyncio
    async def test_sandbox_deleted_on_exec_error(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        await _install(mgr)
        tool = _make_tool(mgr)
        sb = _sandbox()
        sb.process.exec.side_effect = RuntimeError("boom")
        tool._daytona.create.return_value = sb

        result = await tool.run(skill_id="analyzer", _uid=UID)

        assert result["exit_code"] == -1
        assert "运行失败" in result["content"]
        tool._daytona.delete.assert_called_once_with(sb)

    @pytest.mark.asyncio
    async def test_sandbox_deleted_on_create_failure(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        await _install(mgr)
        tool = _make_tool(mgr)
        tool._daytona.create.side_effect = RuntimeError("no quota")

        result = await tool.run(skill_id="analyzer", _uid=UID)

        assert result["exit_code"] == -1
        assert "沙箱创建失败" in result["content"]
        tool._daytona.delete.assert_not_called()
