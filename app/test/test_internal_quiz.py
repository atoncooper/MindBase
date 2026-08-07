"""Tests for QuizGenService (async + idempotent quiz generation service)."""

import pytest

from app.services.quiz_gen import service as qgs
from app.services.quiz_gen.service import QuizGenService


class FakeSettings:
    def __init__(self, api_key="fake-key", base_url=None, model="test"):
        self.openai_api_key = api_key
        self.openai_base_url = base_url
        self.llm_model = model


class FakeMongoColl:
    def __init__(self, doc=None):
        self.doc = doc
        self.inserted = []
        self.updated = []
        self.deleted = []

    async def find_one(self, query):
        return self.doc

    async def insert_one(self, doc):
        self.inserted.append(doc)

    async def update_one(self, query, update):
        self.updated.append((query, update))

    async def delete_one(self, query):
        self.deleted.append(query)
        self.doc = None


def mock_mongo(monkeypatch, coll):
    monkeypatch.setattr(qgs, "is_enabled", lambda: True)
    monkeypatch.setattr(qgs, "coll", lambda name: coll)


# ── generate: async + idempotent ─────────────────────────────────

@pytest.mark.asyncio
async def test_generate_rejects_empty_prompt(monkeypatch):
    mock_mongo(monkeypatch, FakeMongoColl())
    with pytest.raises(ValueError, match="prompt required"):
        await QuizGenService.generate("t1", "  ", "medium", 1)


@pytest.mark.asyncio
async def test_generate_503_without_api_key(monkeypatch):
    monkeypatch.setattr(qgs, "settings", FakeSettings(api_key=""))
    mock_mongo(monkeypatch, FakeMongoColl())
    with pytest.raises(RuntimeError, match="LLM not configured"):
        await QuizGenService.generate("t1", "p", "medium", 1)


@pytest.mark.asyncio
async def test_generate_starts_generation(monkeypatch):
    monkeypatch.setattr(qgs, "settings", FakeSettings(api_key="fake-key"))
    coll = FakeMongoColl(doc=None)
    mock_mongo(monkeypatch, coll)
    async def noop_bg(*a):
        pass
    monkeypatch.setattr(qgs, "_generate_quiz_bg", noop_bg)

    resp = await QuizGenService.generate("t1", "p", "hard", 1)

    assert resp["status"] == "generating"
    assert len(coll.inserted) == 1
    assert coll.inserted[0]["status"] == "generating"


@pytest.mark.asyncio
async def test_generate_idempotent_ready(monkeypatch):
    monkeypatch.setattr(qgs, "settings", FakeSettings(api_key="fake-key"))
    ready_doc = {"task_id": "t1", "status": "ready", "question": "q", "answer": "A"}
    coll = FakeMongoColl(doc=ready_doc)
    mock_mongo(monkeypatch, coll)

    resp = await QuizGenService.generate("t1", "p", "medium", 1)

    assert resp["status"] == "ready"
    assert resp["quiz"]["question"] == "q"
    assert len(coll.inserted) == 0


@pytest.mark.asyncio
async def test_generate_idempotent_generating(monkeypatch):
    monkeypatch.setattr(qgs, "settings", FakeSettings(api_key="fake-key"))
    coll = FakeMongoColl(doc={"task_id": "t1", "status": "generating"})
    mock_mongo(monkeypatch, coll)

    resp = await QuizGenService.generate("t1", "p", "medium", 1)

    assert resp["status"] == "generating"
    assert len(coll.inserted) == 0


# ── get_status ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_status_ready(monkeypatch):
    coll = FakeMongoColl(doc={"task_id": "t1", "status": "ready", "question": "q", "answer": "A"})
    mock_mongo(monkeypatch, coll)
    resp = await QuizGenService.get_status("t1")
    assert resp["status"] == "ready"
    assert resp["quiz"]["question"] == "q"


@pytest.mark.asyncio
async def test_get_status_generating(monkeypatch):
    coll = FakeMongoColl(doc={"task_id": "t1", "status": "generating"})
    mock_mongo(monkeypatch, coll)
    resp = await QuizGenService.get_status("t1")
    assert resp["status"] == "generating"


@pytest.mark.asyncio
async def test_get_status_failed(monkeypatch):
    coll = FakeMongoColl(doc={"task_id": "t1", "status": "failed", "error": "LLM error"})
    mock_mongo(monkeypatch, coll)
    resp = await QuizGenService.get_status("t1")
    assert resp["status"] == "failed"
    assert resp["error"] == "LLM error"


@pytest.mark.asyncio
async def test_get_status_no_doc(monkeypatch):
    coll = FakeMongoColl(doc=None)
    mock_mongo(monkeypatch, coll)
    resp = await QuizGenService.get_status("t1")
    assert resp["status"] == "generating"
