"""Tests for quiz-from-summary generation and the forced-skill plumbing.

Covers the pure helpers (chunk splitting / type distribution), the
non-streaming ``get_or_create_summary`` reuse path, request validation in
``prepare_summary_generation``, and the ``skill_ids`` passthrough in the
chat dispatcher.
"""

import pytest
from fastapi import HTTPException

from app.response.chat import ChatRequest
from app.services import session_summary as session_summary_service
from app.services.quiz_from_summary import (
    default_type_distribution,
    prepare_summary_generation,
    split_summary_to_chunks,
)


# ── split_summary_to_chunks ───────────────────────────────────────────


class TestSplitSummaryToChunks:
    def test_merges_short_paragraphs(self):
        summary = "\n\n".join(["短段落一。" * 5, "短段落二。" * 5, "短段落三。" * 5] * 3)
        chunks = split_summary_to_chunks(summary)
        assert len(chunks) >= 1
        assert all(c["title"] == "会话总结" for c in chunks)
        # Merging: fewer chunks than the paragraph count.
        assert len(chunks) < 9

    def test_hard_splits_overlong_paragraph(self):
        summary = "很长的内容。" * 800  # ~4000 chars, single paragraph
        chunks = split_summary_to_chunks(summary)
        assert len(chunks) >= 2
        assert all(len(c["content"]) <= 3000 for c in chunks)

    def test_drops_fragments_below_min_length(self):
        assert split_summary_to_chunks("太短。\n\n也短。") == []

    def test_respects_max_chunks(self):
        summary = "\n\n".join(
            f"段落{i}：" + "足够长的内容。" * 20 for i in range(30)
        )
        assert len(split_summary_to_chunks(summary)) <= 20


# ── default_type_distribution ─────────────────────────────────────────


class TestDefaultTypeDistribution:
    @pytest.mark.parametrize("n", [1, 2, 3, 5, 8, 10, 15, 20])
    def test_sums_to_question_count(self, n):
        dist = default_type_distribution(n)
        assert sum(dist.values()) == n
        assert all(v > 0 for v in dist.values())


# ── get_or_create_summary (non-streaming reuse path) ──────────────────


class _FakeLifecycle:
    def __init__(self, output: dict):
        self.output = output
        self.calls: list[tuple] = []

    async def invoke(self, name: str, session_key: str, **kwargs):
        self.calls.append((name, session_key, kwargs))
        return self.output


class _FakeHarness:
    def __init__(self, output: dict):
        self.lifecycle = _FakeLifecycle(output)


class TestGetOrCreateSummary:
    @pytest.mark.asyncio
    async def test_returns_persisted_summary_without_invoking_agent(
        self, monkeypatch
    ):
        async def fake_latest(chat_session_id, uid):
            return {"content": "已有总结"}

        monkeypatch.setattr(
            "app.repository.mongo_summary_repository.get_latest_summary_for_user",
            fake_latest,
        )
        harness = _FakeHarness({"result": "不应被调用"})

        content = await session_summary_service.get_or_create_summary(
            1, "sess", harness
        )

        assert content == "已有总结"
        assert harness.lifecycle.calls == []

    @pytest.mark.asyncio
    async def test_generates_and_persists_when_absent(self, monkeypatch):
        async def fake_latest(chat_session_id, uid):
            return None

        monkeypatch.setattr(
            "app.repository.mongo_summary_repository.get_latest_summary_for_user",
            fake_latest,
        )

        persisted: list[tuple] = []

        async def fake_insert(uid, chat_session_id, content, final_state):
            persisted.append((uid, chat_session_id, content))
            return "sid", 3

        monkeypatch.setattr(
            session_summary_service, "_insert_summary_record", fake_insert
        )

        harness = _FakeHarness({"result": "新总结内容", "message_count": 3})
        content = await session_summary_service.get_or_create_summary(
            1, "sess", harness
        )

        assert content == "新总结内容"
        assert persisted == [(1, "sess", "新总结内容")]
        # Invoked the registered summary agent under the isolated session key.
        name, session_key, kwargs = harness.lifecycle.calls[0]
        assert name == "summary"
        assert session_key == "summary:sess"
        assert kwargs["chat_session_id"] == "sess"

    @pytest.mark.asyncio
    async def test_raises_on_agent_error(self, monkeypatch):
        async def fake_latest(chat_session_id, uid):
            return None

        monkeypatch.setattr(
            "app.repository.mongo_summary_repository.get_latest_summary_for_user",
            fake_latest,
        )
        harness = _FakeHarness({"result": "", "error": "boom"})
        with pytest.raises(RuntimeError, match="会话总结生成失败"):
            await session_summary_service.get_or_create_summary(1, "sess", harness)

    @pytest.mark.asyncio
    async def test_raises_on_fallback_result(self, monkeypatch):
        from app.agent.summary.prompts import FALLBACK_RESULT

        async def fake_latest(chat_session_id, uid):
            return None

        monkeypatch.setattr(
            "app.repository.mongo_summary_repository.get_latest_summary_for_user",
            fake_latest,
        )
        harness = _FakeHarness({"result": FALLBACK_RESULT})
        with pytest.raises(RuntimeError):
            await session_summary_service.get_or_create_summary(1, "sess", harness)


# ── prepare_summary_generation (request validation) ───────────────────


class TestPrepareSummaryGeneration:
    @pytest.mark.asyncio
    async def test_404_when_session_missing(self, monkeypatch):
        async def fake_get(db, uid, chat_session_id):
            return None

        monkeypatch.setattr(
            "app.services.chat_history.get_chat_session_for_user", fake_get
        )
        with pytest.raises(HTTPException) as ei:
            await prepare_summary_generation(None, 1, "s", None)
        assert ei.value.status_code == 404

    @pytest.mark.asyncio
    async def test_400_when_session_empty(self, monkeypatch):
        async def fake_get(db, uid, chat_session_id):
            return object()

        async def fake_has(chat_session_id):
            return False

        monkeypatch.setattr(
            "app.services.chat_history.get_chat_session_for_user", fake_get
        )
        monkeypatch.setattr(
            "app.repository.mongo_chat_repository.session_has_messages", fake_has
        )
        with pytest.raises(HTTPException) as ei:
            await prepare_summary_generation(None, 1, "s", None)
        assert ei.value.status_code == 400

    @pytest.mark.asyncio
    async def test_503_when_harness_not_started(self, monkeypatch):
        async def fake_get(db, uid, chat_session_id):
            return object()

        async def fake_has(chat_session_id):
            return True

        monkeypatch.setattr(
            "app.services.chat_history.get_chat_session_for_user", fake_get
        )
        monkeypatch.setattr(
            "app.repository.mongo_chat_repository.session_has_messages", fake_has
        )
        with pytest.raises(HTTPException) as ei:
            await prepare_summary_generation(None, 1, "s", None)
        assert ei.value.status_code == 503


# ── dispatcher skill_ids passthrough ──────────────────────────────────


class TestDispatcherSkillIdsPassthrough:
    @pytest.mark.asyncio
    async def test_agent_stream_setup_passes_skill_ids(self, monkeypatch):
        from app.services.chat import dispatcher

        async def fake_resolve(request, *, db, uid):
            return {
                "bvids": [],
                "media_ids": [],
                "workspace_pages": [],
                "upload_uuids": [],
            }

        monkeypatch.setattr(dispatcher, "_resolve_agent_context", fake_resolve)

        captured: dict = {}

        class FakeHarness:
            started = True

            async def dispatch_stream(self, session_id, *, query, **kwargs):
                captured["kwargs"] = kwargs
                return "chat", object()

        request = ChatRequest(question="q", skill_ids=["s1", "s2"])
        _name, _graph, input_state, _config = await dispatcher.agent_stream_setup(
            request,
            uid=1,
            db=None,
            agent_harness=FakeHarness(),
            session_id="sess",
            query="q",
        )

        assert captured["kwargs"]["skill_ids"] == ["s1", "s2"]
        assert input_state["skill_ids"] == ["s1", "s2"]

    @pytest.mark.asyncio
    async def test_agent_stream_setup_defaults_skill_ids_empty(self, monkeypatch):
        from app.services.chat import dispatcher

        async def fake_resolve(request, *, db, uid):
            return {
                "bvids": [],
                "media_ids": [],
                "workspace_pages": [],
                "upload_uuids": [],
            }

        monkeypatch.setattr(dispatcher, "_resolve_agent_context", fake_resolve)

        class FakeHarness:
            started = True

            async def dispatch_stream(self, session_id, *, query, **kwargs):
                return "chat", object()

        request = ChatRequest(question="q")
        _name, _graph, input_state, _config = await dispatcher.agent_stream_setup(
            request,
            uid=1,
            db=None,
            agent_harness=FakeHarness(),
            session_id="sess",
            query="q",
        )

        assert input_state["skill_ids"] == []


# ── quota: peek semantics + router ordering ───────────────────────────


class _FakeRedis:
    def __init__(self, count: int):
        self._count = count

    async def get(self, key: str):
        return str(self._count).encode() if self._count else None


class TestCheckQuotaPeek:
    @pytest.mark.asyncio
    async def test_raises_when_exhausted(self, monkeypatch):
        from app.services.llm import quiz_quota

        limit = quiz_quota._daily_limit("generate")
        monkeypatch.setattr(quiz_quota, "_redis", _FakeRedis(limit))
        with pytest.raises(quiz_quota.QuizQuotaExceeded):
            await quiz_quota.check_quota(1, "generate")

    @pytest.mark.asyncio
    async def test_passes_when_below_limit(self, monkeypatch):
        from app.services.llm import quiz_quota

        limit = quiz_quota._daily_limit("generate")
        monkeypatch.setattr(quiz_quota, "_redis", _FakeRedis(max(0, limit - 1)))
        await quiz_quota.check_quota(1, "generate")  # must not raise

    @pytest.mark.asyncio
    async def test_fail_open_without_redis(self, monkeypatch):
        from app.services.llm import quiz_quota

        monkeypatch.setattr(quiz_quota, "_redis", None)
        await quiz_quota.check_quota(1, "generate")  # must not raise


class _Recorder:
    def __init__(self):
        self.calls: list[str] = []

    async def noop(self, *args, **kwargs):
        return None


@pytest.mark.asyncio
async def test_generate_from_summary_quota_order_and_success(monkeypatch):
    """peek → create → consume; all three run in that order on success."""
    from types import SimpleNamespace

    from fastapi import BackgroundTasks

    from app.routers import quiz as quiz_router
    from app.services.llm import quiz_quota

    rec: list[str] = []

    async def fake_prepare(db, uid, chat_session_id, agent_harness):
        rec.append("prepare")

    async def fake_peek(uid, kind):
        rec.append("peek")

    async def fake_consume(uid, kind):
        rec.append("consume")

    async def fake_create(self, **kwargs):
        rec.append("create")
        return "quiz-uuid-1"

    monkeypatch.setattr(quiz_router, "prepare_summary_generation", fake_prepare)
    monkeypatch.setattr(quiz_quota, "check_quota", fake_peek)
    monkeypatch.setattr(quiz_quota, "check_and_consume", fake_consume)
    monkeypatch.setattr(
        quiz_router.QuizFromSummaryService, "create_quiz_set", fake_create
    )

    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(agent_harness=None))
    )
    body = quiz_router.QuizFromSummaryGenerateRequest(
        chat_session_id="sess", question_count=5, difficulty="medium"
    )

    result = await quiz_router.generate_quiz_from_summary(
        body=body,
        request=request,
        uid=1,
        db=None,
        background_tasks=BackgroundTasks(),
    )

    assert result == {"quiz_uuid": "quiz-uuid-1", "status": "generating"}
    assert rec == ["prepare", "peek", "create", "consume"]


@pytest.mark.asyncio
async def test_generate_from_summary_quota_denied_skips_create(monkeypatch):
    """Denied peek → 429, and no row is created / nothing consumed."""
    from types import SimpleNamespace

    from fastapi import BackgroundTasks, HTTPException

    from app.routers import quiz as quiz_router
    from app.services.llm import quiz_quota

    rec: list[str] = []

    async def fake_prepare(db, uid, chat_session_id, agent_harness):
        rec.append("prepare")

    async def fake_peek(uid, kind):
        rec.append("peek")
        raise quiz_quota.QuizQuotaExceeded(kind, 5)

    async def fake_consume(uid, kind):
        rec.append("consume")

    async def fake_create(self, **kwargs):
        rec.append("create")
        return "quiz-uuid-1"

    monkeypatch.setattr(quiz_router, "prepare_summary_generation", fake_prepare)
    monkeypatch.setattr(quiz_quota, "check_quota", fake_peek)
    monkeypatch.setattr(quiz_quota, "check_and_consume", fake_consume)
    monkeypatch.setattr(
        quiz_router.QuizFromSummaryService, "create_quiz_set", fake_create
    )

    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(agent_harness=None))
    )
    body = quiz_router.QuizFromSummaryGenerateRequest(
        chat_session_id="sess", question_count=5, difficulty="medium"
    )

    with pytest.raises(HTTPException) as ei:
        await quiz_router.generate_quiz_from_summary(
            body=body,
            request=request,
            uid=1,
            db=None,
            background_tasks=BackgroundTasks(),
        )

    assert ei.value.status_code == 429
    assert rec == ["prepare", "peek"]


@pytest.mark.asyncio
async def test_generate_from_summary_consume_race_tolerated(monkeypatch):
    """Consume raising after row creation must not fail the request."""
    from types import SimpleNamespace

    from fastapi import BackgroundTasks

    from app.routers import quiz as quiz_router
    from app.services.llm import quiz_quota

    rec: list[str] = []

    async def fake_prepare(db, uid, chat_session_id, agent_harness):
        rec.append("prepare")

    async def fake_peek(uid, kind):
        rec.append("peek")

    async def fake_consume(uid, kind):
        rec.append("consume")
        raise quiz_quota.QuizQuotaExceeded(kind, 5)

    async def fake_create(self, **kwargs):
        rec.append("create")
        return "quiz-uuid-1"

    monkeypatch.setattr(quiz_router, "prepare_summary_generation", fake_prepare)
    monkeypatch.setattr(quiz_quota, "check_quota", fake_peek)
    monkeypatch.setattr(quiz_quota, "check_and_consume", fake_consume)
    monkeypatch.setattr(
        quiz_router.QuizFromSummaryService, "create_quiz_set", fake_create
    )

    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(agent_harness=None))
    )
    body = quiz_router.QuizFromSummaryGenerateRequest(
        chat_session_id="sess", question_count=5, difficulty="medium"
    )

    result = await quiz_router.generate_quiz_from_summary(
        body=body,
        request=request,
        uid=1,
        db=None,
        background_tasks=BackgroundTasks(),
    )

    assert result == {"quiz_uuid": "quiz-uuid-1", "status": "generating"}
    assert rec == ["prepare", "peek", "create", "consume"]

