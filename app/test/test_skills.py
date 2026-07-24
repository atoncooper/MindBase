"""Tests for Skills - per-user MinIO-backed lazy load + MySQL index.

Covers SkillManager (install/load/uninstall/cache, per uid), zip_parser,
and the LoadSkillTool. No local filesystem - skills live in MinIO (mocked
here) and their metadata in MySQL (in-memory SQLite). Each user manages
their own installed skills.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.skills.manager import SkillManager
from app.skills.zip_parser import (
    Skill,
    build_skill_zip,
    parse_skill_zip,
    read_manifest,
)
from app.tools import ToolDeps
from app.tools.skill.load_skill import LoadSkillTool

UID = 1


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


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
    """In-memory MinIO stand-in: put/get/delete backed by a dict."""
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


def _make_zip(*, body: str = "# Skill\n步骤1\n", has_code_tools: bool = False, name: str = "demo") -> bytes:
    return build_skill_zip(
        skill_md=body,
        manifest={
            "skill_id": name,
            "name": name,
            "description": f"{name} description",
            "version": "1.0",
            "has_code_tools": has_code_tools,
        },
    )


# ---------------------------------------------------------------------------
# zip_parser
# ---------------------------------------------------------------------------


class TestZipParser:
    def test_parse_skill_zip_extracts_body_and_flags(self) -> None:
        zip_bytes = build_skill_zip(
            skill_md="# Title\n正文内容",
            manifest={"has_code_tools": True, "resources": ["a.md", "b.md"]},
        )
        skill = parse_skill_zip(zip_bytes, skill_id="x", name="X", description="d")
        assert isinstance(skill, Skill)
        assert "正文内容" in skill.body
        assert skill.has_code_tools is True
        assert skill.resources == ["a.md", "b.md"]

    def test_parse_skill_zip_strips_frontmatter(self) -> None:
        zip_bytes = build_skill_zip(
            skill_md="---\nname: ignored\n---\n正文",
            manifest={},
        )
        skill = parse_skill_zip(zip_bytes, skill_id="x", name="X")
        assert skill.body == "正文"

    def test_read_manifest_returns_dict(self) -> None:
        zip_bytes = _make_zip(name="abc")
        m = read_manifest(zip_bytes)
        assert m["name"] == "abc"
        assert m["has_code_tools"] is False

    def test_read_manifest_empty_when_missing(self) -> None:
        zip_bytes = build_skill_zip(skill_md="body", manifest={})
        assert read_manifest(zip_bytes) == {}


# ---------------------------------------------------------------------------
# SkillManager (per-user)
# ---------------------------------------------------------------------------


class TestSkillManager:
    @pytest.mark.asyncio
    async def test_install_then_load_roundtrip(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        zip_bytes = _make_zip(body="# 视频总结\n步骤1 检索\n")

        await mgr.install(
            uid=UID,
            skill_id="video-summary",
            name="video-summary",
            description="深度总结视频",
            version="1.0",
            source_store="upload",
            zip_bytes=zip_bytes,
            manifest={"has_code_tools": False},
        )

        skill = await mgr.load_skill(UID, "video-summary")
        assert skill is not None
        assert skill.name == "video-summary"
        assert "步骤1" in skill.body
        assert f"skills/{UID}/video-summary.zip" in mock_minio._store

    @pytest.mark.asyncio
    async def test_load_unknown_returns_none(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        assert await mgr.load_skill(UID, "nope") is None

    @pytest.mark.asyncio
    async def test_skills_are_per_user(self, session_factory, mock_minio) -> None:
        """User 1's installed skill is invisible to user 2."""
        mgr = SkillManager(session_factory, mock_minio)
        await mgr.install(
            uid=1, skill_id="a", name="a", description="A", version=None,
            source_store="upload", zip_bytes=_make_zip(name="a"), manifest={},
        )
        assert await mgr.load_skill(1, "a") is not None
        assert await mgr.load_skill(2, "a") is None  # different user
        assert await mgr.index_text(2) == ""

    @pytest.mark.asyncio
    async def test_index_text_lists_installed(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        await mgr.install(
            uid=UID, skill_id="a", name="a", description="A 技能", version=None,
            source_store="upload", zip_bytes=_make_zip(name="a"), manifest={},
        )
        await mgr.install(
            uid=UID, skill_id="b", name="b", description="B 技能", version=None,
            source_store="upload", zip_bytes=_make_zip(name="b"), manifest={},
        )

        idx = await mgr.index_text(UID)
        assert "a" in idx and "b" in idx
        assert "load_skill" in idx

    @pytest.mark.asyncio
    async def test_index_text_empty_when_none(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        assert await mgr.index_text(UID) == ""

    @pytest.mark.asyncio
    async def test_uninstall_removes_minio_and_row(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        await mgr.install(
            uid=UID, skill_id="x", name="x", description="", version=None,
            source_store="upload", zip_bytes=_make_zip(), manifest={},
        )
        assert await mgr.uninstall(UID, "x") is True
        assert f"skills/{UID}/x.zip" not in mock_minio._store
        assert await mgr.load_skill(UID, "x") is None

    @pytest.mark.asyncio
    async def test_uninstall_unknown_returns_false(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        assert await mgr.uninstall(UID, "missing") is False

    @pytest.mark.asyncio
    async def test_load_uses_cache_after_first_fetch(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        await mgr.install(
            uid=UID, skill_id="x", name="x", description="", version=None,
            source_store="upload", zip_bytes=_make_zip(), manifest={},
        )
        s1 = await mgr.load_skill(UID, "x")
        s2 = await mgr.load_skill(UID, "x")
        assert s1 is s2
        assert mock_minio.get_object.call_count == 1  # second load from cache

    @pytest.mark.asyncio
    async def test_install_upsert_overwrites(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        await mgr.install(
            uid=UID, skill_id="x", name="old", description="old", version="1",
            source_store="upload", zip_bytes=_make_zip(body="old body"), manifest={},
        )
        await mgr.install(
            uid=UID, skill_id="x", name="new", description="new", version="2",
            source_store="upload", zip_bytes=_make_zip(body="new body"), manifest={},
        )
        mgr.invalidate(UID, "x")
        skill = await mgr.load_skill(UID, "x")
        assert skill is not None
        assert "new body" in skill.body
        skills = await mgr.list_installed(UID)
        assert len(skills) == 1  # upsert, not duplicate

    @pytest.mark.asyncio
    async def test_has_code_tools_flag_propagates(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        await mgr.install(
            uid=UID, skill_id="code", name="code", description="", version=None,
            source_store="upload",
            zip_bytes=_make_zip(body="body", has_code_tools=True),
            manifest={"has_code_tools": True},
        )
        skill = await mgr.load_skill(UID, "code")
        assert skill is not None
        assert skill.has_code_tools is True

    @pytest.mark.asyncio
    async def test_no_session_factory_degrades_gracefully(self, mock_minio) -> None:
        mgr = SkillManager(None, mock_minio)
        assert await mgr.list_installed(UID) == []
        assert await mgr.index_text(UID) == ""
        assert await mgr.load_skill(UID, "x") is None

    @pytest.mark.asyncio
    async def test_preview_skill_returns_body_and_files(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        zip_bytes = build_skill_zip(
            skill_md="# 视频总结\n步骤1 检索\n",
            manifest={"skill_id": "video-summary", "name": "Video", "has_code_tools": False},
        )
        await mgr.install(
            uid=UID, skill_id="video-summary", name="Video", description="d",
            version="1", source_store="upload", zip_bytes=zip_bytes,
            manifest={"has_code_tools": False},
        )
        result = await mgr.preview_skill(UID, "video-summary")
        assert result is not None
        assert "步骤1" in result["body"]
        assert any(f["name"] == "SKILL.md" for f in result["files"])
        assert result["name"] == "Video"
        assert result["has_code_tools"] is False

    @pytest.mark.asyncio
    async def test_preview_skill_unknown_returns_none(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        assert await mgr.preview_skill(UID, "nope") is None

    @pytest.mark.asyncio
    async def test_preview_skill_handles_zipball_prefix(self, session_factory, mock_minio) -> None:
        """Preview a zipball-style zip (files under owner-repo-sha/ prefix)."""
        import io as _io
        import zipfile as _zip
        import json as _json
        buf = _io.BytesIO()
        with _zip.ZipFile(buf, "w", _zip.ZIP_DEFLATED) as zf:
            zf.writestr("owner-repo-abc/SKILL.md", "# Title\nbody")
            zf.writestr("owner-repo-abc/manifest.json", _json.dumps({"has_code_tools": True}))
        zip_bytes = buf.getvalue()
        mgr = SkillManager(session_factory, mock_minio)
        await mgr.install(
            uid=UID, skill_id="prefixed", name="P", description="",
            version=None, source_store="upload", zip_bytes=zip_bytes,
            manifest={"has_code_tools": True},
        )
        result = await mgr.preview_skill(UID, "prefixed")
        assert result is not None
        assert "body" in result["body"]
        assert result["has_code_tools"] is True


# ---------------------------------------------------------------------------
# LoadSkillTool
# ---------------------------------------------------------------------------


class TestLoadSkillTool:
    @pytest.mark.asyncio
    async def test_load_known_skill_returns_body(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        await mgr.install(
            uid=UID, skill_id="video-summary", name="video-summary", description="d",
            version="1", source_store="upload",
            zip_bytes=_make_zip(body="# 视频总结\n步骤1\n"), manifest={},
        )
        tool = LoadSkillTool(mgr)
        result = await tool.run(name="video-summary", _uid=UID)
        assert "步骤1" in result
        assert "视频总结" in result

    @pytest.mark.asyncio
    async def test_load_without_uid_returns_error(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        tool = LoadSkillTool(mgr)
        result = await tool.run(name="x")  # no _uid
        assert "_uid" in result or "用户上下文" in result

    @pytest.mark.asyncio
    async def test_load_unknown_lists_available(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        await mgr.install(
            uid=UID, skill_id="video-summary", name="video-summary", description="d",
            version="1", source_store="upload", zip_bytes=_make_zip(), manifest={},
        )
        tool = LoadSkillTool(mgr)
        result = await tool.run(name="nope", _uid=UID)
        assert "nope" in result or "未知" in result
        assert "video-summary" in result

    @pytest.mark.asyncio
    async def test_code_tools_warning(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        await mgr.install(
            uid=UID, skill_id="code", name="code", description="", version=None,
            source_store="upload",
            zip_bytes=_make_zip(body="body", has_code_tools=True),
            manifest={"has_code_tools": True},
        )
        tool = LoadSkillTool(mgr)
        result = await tool.run(name="code", _uid=UID)
        assert "代码工具" in result
        assert "沙箱" in result

    def test_from_deps_returns_none_when_no_skill_manager(self) -> None:
        assert LoadSkillTool.from_deps(ToolDeps()) is None

    def test_from_deps_returns_tool_when_skill_manager_present(
        self, session_factory, mock_minio
    ) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        assert LoadSkillTool.from_deps(ToolDeps(skill_manager=mgr)) is not None

    def test_name_and_parameters(self, session_factory, mock_minio) -> None:
        mgr = SkillManager(session_factory, mock_minio)
        tool = LoadSkillTool(mgr)
        assert tool.name == "load_skill"
        params = tool.parameters()
        assert params["type"] == "object"
        assert "name" in params["properties"]
        assert "name" in params["required"]
