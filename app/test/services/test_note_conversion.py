"""Unit tests for the cloud-document → note conversion flow.

Covers:

* ``read_cloud_document_text`` — Mongo full-text read with ownership
  filtering, truncation cap, and not-found semantics.
* ``convert_cloud_document_to_note`` — orchestration: harness checks,
  agent invocation, and error mapping to HTTP status codes.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.services.cloud.document_text import (
    CloudDocumentNotFoundError,
    MAX_DOC_TEXT_CHARS,
    read_cloud_document_text,
)
from app.services.note_conversion import convert_cloud_document_to_note

pytestmark = pytest.mark.asyncio

UID = 7
UUID = "0123abcd-4c5d-6e7f-8a9b-0123456789ab"


# ── fakes ─────────────────────────────────────────────────────────────


class _FakeCollection:
    def __init__(self, doc: dict | None) -> None:
        self._doc = doc
        self.query: dict | None = None

    async def find_one(self, query: dict, projection: dict) -> dict | None:
        self.query = query
        return self._doc


class _FakeDb:
    def __init__(self, doc: dict | None) -> None:
        self.coll = _FakeCollection(doc)

    def __getitem__(self, name: str) -> _FakeCollection:
        return self.coll


class _FakeLifecycle:
    def __init__(self, result: dict | None = None, error: Exception | None = None):
        self._result = result or {}
        self._error = error
        self.calls: list[dict] = []

    async def invoke(self, agent_name: str, key: str, **kwargs) -> dict:
        if self._error is not None:
            raise self._error
        self.calls.append({"agent": agent_name, "key": key, **kwargs})
        return self._result


class _FakeHarness:
    def __init__(self, lifecycle: _FakeLifecycle, started: bool = True) -> None:
        self.lifecycle = lifecycle
        self.started = started


@pytest.fixture
def patch_mongo(monkeypatch):
    def _install(doc: dict | None):
        fake_db = _FakeDb(doc)
        import app.infra.mongo as mongo_mod

        monkeypatch.setattr(mongo_mod, "get_database", lambda: fake_db)
        return fake_db

    return _install


# ── read_cloud_document_text ──────────────────────────────────────────


class TestReadCloudDocumentText:
    async def test_reads_full_text(self, patch_mongo):
        patch_mongo(
            {
                "title": "设计文档.pdf",
                "content": "# 标题\n正文",
                "content_source": "pdfplumber",
            }
        )
        out = await read_cloud_document_text(UUID, UID)

        assert out["file_name"] == "设计文档.pdf"
        assert out["content"] == "# 标题\n正文"
        assert out["truncated"] is False

    async def test_query_filters_by_uid(self, patch_mongo):
        """Ownership is enforced by the (upload_uuid, uid) compound filter."""
        fake_db = patch_mongo(None)

        with pytest.raises(CloudDocumentNotFoundError):
            await read_cloud_document_text(UUID, UID)
        assert fake_db.coll.query == {"upload_uuid": UUID, "uid": UID}

    async def test_empty_content_is_not_found(self, patch_mongo):
        patch_mongo({"title": "x", "content": "", "content_source": ""})
        with pytest.raises(CloudDocumentNotFoundError):
            await read_cloud_document_text(UUID, UID)

    async def test_truncation_cap(self, patch_mongo, monkeypatch):
        long_text = "字" * (MAX_DOC_TEXT_CHARS + 1000)
        patch_mongo({"title": "big.md", "content": long_text})

        out = await read_cloud_document_text(UUID, UID)
        assert len(out["content"]) == MAX_DOC_TEXT_CHARS
        assert out["truncated"] is True

    async def test_mongo_down_raises_runtime_error(self, monkeypatch):
        import app.infra.mongo as mongo_mod

        monkeypatch.setattr(mongo_mod, "get_database", lambda: None)
        with pytest.raises(RuntimeError):
            await read_cloud_document_text(UUID, UID)


# ── convert_cloud_document_to_note ────────────────────────────────────


class TestConvertCloudDocumentToNote:
    async def test_success_returns_agent_message(self, patch_mongo):
        patch_mongo(
            {"title": "设计文档.pdf", "content": "# 标题\n正文"}
        )
        lifecycle = _FakeLifecycle(result={"result": "已保存笔记《设计文档》"})
        harness = _FakeHarness(lifecycle)

        out = await convert_cloud_document_to_note(UID, UUID, harness)

        assert out["message"] == "已保存笔记《设计文档》"
        call = lifecycle.calls[0]
        assert call["agent"] == "note"
        assert call["key"].startswith("notedoc:")
        assert call["uid"] == UID
        assert call["cloud_upload_uuid"] == UUID
        assert call["cloud_file_name"] == "设计文档.pdf"
        assert call["cloud_doc_text"] == "# 标题\n正文"

    async def test_harness_not_started_is_503(self, patch_mongo):
        with pytest.raises(HTTPException) as exc:
            await convert_cloud_document_to_note(UID, UUID, _FakeHarness(_FakeLifecycle(), started=False))
        assert exc.value.status_code == 503

    async def test_missing_harness_is_503(self):
        with pytest.raises(HTTPException) as exc:
            await convert_cloud_document_to_note(UID, UUID, None)
        assert exc.value.status_code == 503

    async def test_unparsed_document_is_409(self, patch_mongo):
        patch_mongo(None)
        with pytest.raises(HTTPException) as exc:
            await convert_cloud_document_to_note(
                UID, UUID, _FakeHarness(_FakeLifecycle())
            )
        assert exc.value.status_code == 409

    async def test_agent_error_is_502(self, patch_mongo):
        patch_mongo({"title": "t", "content": "c"})
        harness = _FakeHarness(_FakeLifecycle(result={"error": "boom"}))
        with pytest.raises(HTTPException) as exc:
            await convert_cloud_document_to_note(UID, UUID, harness)
        assert exc.value.status_code == 502

    async def test_empty_result_is_502(self, patch_mongo):
        patch_mongo({"title": "t", "content": "c"})
        harness = _FakeHarness(_FakeLifecycle(result={"result": ""}))
        with pytest.raises(HTTPException) as exc:
            await convert_cloud_document_to_note(UID, UUID, harness)
        assert exc.value.status_code == 502
