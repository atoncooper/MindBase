"""Tests for RunCodeTool artifact extraction + MinIO upload.

Verifies that <<ARTIFACT_START>> markers in sandbox stdout are extracted,
uploaded to MinIO, and the returned content is cleaned of base64 noise so
the LLM never sees megabytes of encoded data.
"""

import base64
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

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


class TestRunCodeArtifacts:
    async def test_artifact_extracted_uploaded_and_content_cleaned(self):
        payload = b"\x89PNG fake image"
        b64 = base64.b64encode(payload).decode()
        sandbox = MagicMock()
        sandbox.process.code_run.return_value = SimpleNamespace(
            result=f"exitCode=0\n<<ARTIFACT_START:heart.png>>{b64}<<ARTIFACT_END>>",
            exit_code=0,
        )
        daytona = MagicMock()
        daytona.create.return_value = sandbox
        tool = _make_tool(daytona)

        minio_client = MagicMock()
        minio_client.put_object = AsyncMock()
        minio_client.presigned_get = AsyncMock(return_value="https://minio/heart.png")

        with patch("app.infra.minio.is_enabled", return_value=True), patch(
            "app.infra.minio.get_minio_client", return_value=minio_client
        ):
            result = await tool.run(code="print(1)", language="python", _uid=1)

        assert result["exit_code"] == 0
        # Content cleaned: base64 stripped, placeholder present.
        assert b64 not in result["content"]
        assert "[已提取产物: heart.png]" in result["content"]
        # Artifacts carry MinIO metadata, not raw bytes.
        assert len(result["artifacts"]) == 1
        art = result["artifacts"][0]
        assert art["name"] == "heart.png"
        assert art["url"] == "https://minio/heart.png"
        assert art["minio_key"].startswith("code-artifacts/1/")
        assert "data" not in art  # raw bytes must not leak to the LLM
        minio_client.put_object.assert_awaited_once()
        minio_client.presigned_get.assert_awaited_once()

    async def test_minio_disabled_skips_artifact_persistence(self):
        b64 = base64.b64encode(b"x").decode()
        sandbox = MagicMock()
        sandbox.process.code_run.return_value = SimpleNamespace(
            result=f"<<ARTIFACT_START:a.png>>{b64}<<ARTIFACT_END>>",
            exit_code=0,
        )
        daytona = MagicMock()
        daytona.create.return_value = sandbox
        tool = _make_tool(daytona)

        with patch("app.infra.minio.is_enabled", return_value=False):
            result = await tool.run(code="c", language="python", _uid=1)

        # Marker still cleaned from content, but artifact not persisted.
        assert result["artifacts"] == []
        assert "[已提取产物: a.png]" in result["content"]

    async def test_no_artifact_returns_empty_list(self):
        sandbox = MagicMock()
        sandbox.process.code_run.return_value = SimpleNamespace(
            result="plain output",
            exit_code=0,
        )
        daytona = MagicMock()
        daytona.create.return_value = sandbox
        tool = _make_tool(daytona)

        result = await tool.run(code="c", language="python", _uid=1)
        assert result["artifacts"] == []
        assert result["content"] == "exitCode=0\nplain output"


class TestRunCodeFilesystemHarvest:
    """Auto-harvest of generated files from the sandbox filesystem.

    Covers the fallback path: when the LLM just plt.savefig()s without
    emitting the <<ARTIFACT_START>> marker, run_code scans the workdir and
    uploads discovered image/data files so they still come back as URLs.
    """

    async def test_harvest_captures_image_skips_txt_and_dir(self):
        sandbox = MagicMock()
        sandbox.process.code_run.return_value = SimpleNamespace(
            result="done", exit_code=0
        )
        # workdir listing: png (harvest), txt (wrong ext), subdir (dir)
        sandbox.fs.list_files.return_value = [
            SimpleNamespace(is_dir=False, name="chart.png", path="./chart.png", size=9),
            SimpleNamespace(is_dir=False, name="notes.txt", path="./notes.txt", size=4),
            SimpleNamespace(is_dir=True, name="subdir", path="./subdir", size=0),
        ]
        sandbox.fs.download_file.return_value = b"\x89PNGdata"
        daytona = MagicMock()
        daytona.create.return_value = sandbox
        tool = _make_tool(daytona)

        minio_client = MagicMock()
        minio_client.put_object = AsyncMock()
        minio_client.presigned_get = AsyncMock(return_value="https://minio/chart.png")
        with patch("app.infra.minio.is_enabled", return_value=True), patch(
            "app.infra.minio.get_minio_client", return_value=minio_client
        ):
            r = await tool.run(code="plt.savefig('chart.png')", language="python", _uid=2)

        assert r["exit_code"] == 0
        assert len(r["artifacts"]) == 1
        art = r["artifacts"][0]
        assert art["name"] == "chart.png"
        assert art["url"] == "https://minio/chart.png"
        assert art["minio_key"].startswith("code-artifacts/2/")
        assert "data" not in art
        # Only the png was downloaded (txt skipped by ext, dir skipped).
        sandbox.fs.download_file.assert_called_once_with("./chart.png")
        minio_client.put_object.assert_awaited_once()

    async def test_harvest_dedupes_against_marker_artifacts(self):
        # LLM emitted a marker for chart.png AND the file exists in the workdir;
        # harvest must skip it so the artifact isn't uploaded twice.
        payload = b"\x89PNG marker image"
        b64 = base64.b64encode(payload).decode()
        sandbox = MagicMock()
        sandbox.process.code_run.return_value = SimpleNamespace(
            result=f"<<ARTIFACT_START:chart.png>>{b64}<<ARTIFACT_END>>",
            exit_code=0,
        )
        sandbox.fs.list_files.return_value = [
            SimpleNamespace(is_dir=False, name="chart.png", path="./chart.png", size=100),
        ]
        sandbox.fs.download_file.return_value = b"\x89PNG fs image"
        daytona = MagicMock()
        daytona.create.return_value = sandbox
        tool = _make_tool(daytona)

        with patch("app.infra.minio.is_enabled", return_value=True), patch(
            "app.infra.minio.get_minio_client", return_value=MagicMock(
                put_object=AsyncMock(), presigned_get=AsyncMock(return_value="u")
            )
        ):
            r = await tool.run(code="c", language="python", _uid=3)

        # Exactly one artifact (the marker one); harvest download skipped.
        assert len(r["artifacts"]) == 1
        assert r["artifacts"][0]["name"] == "chart.png"
        sandbox.fs.download_file.assert_not_called()

    async def test_harvest_skipped_on_run_failure(self):
        # exit_code != 0 -> no harvest (avoid surfacing junk from failed runs).
        sandbox = MagicMock()
        sandbox.process.code_run.side_effect = RuntimeError("boom")
        sandbox.fs.list_files.return_value = [
            SimpleNamespace(is_dir=False, name="chart.png", path="./chart.png", size=9),
        ]
        daytona = MagicMock()
        daytona.create.return_value = sandbox
        tool = _make_tool(daytona)

        r = await tool.run(code="c", language="python", _uid=4)
        assert r["exit_code"] == -1
        assert r["artifacts"] == []
        sandbox.fs.list_files.assert_not_called()

    async def test_harvest_timeout_does_not_block_deletion(self, monkeypatch):
        # A hung list_files is bounded by HARVEST_TIMEOUT; the run still
        # returns and the sandbox is still deleted (no resource leak).
        monkeypatch.setattr(run_code_module, "HARVEST_TIMEOUT", 0.3)
        sandbox = MagicMock()
        sandbox.process.code_run.return_value = SimpleNamespace(result="ok", exit_code=0)
        sandbox.fs.list_files.side_effect = lambda *a, **k: time.sleep(1.0) or []
        daytona = MagicMock()
        daytona.create.return_value = sandbox
        tool = _make_tool(daytona)

        r = await tool.run(code="c", language="python", _uid=5)
        assert r["exit_code"] == 0
        assert r["artifacts"] == []
        daytona.delete.assert_called_once()
