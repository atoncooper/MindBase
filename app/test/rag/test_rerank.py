"""Unit tests for app.services.rag.rerank.Reranker (strategy pattern).

Covers the rerank work landed in this change:
- rerank.py: single Reranker class with 5 dispatched algorithms
  (null / dashscope / hybrid / mmr / llm), dispatch entry point,
  from_settings(), get_reranker() singleton.
- legacy.py search(): over-recall + rerank call integration.

External calls (DashScope HTTP) are mocked; no network or Milvus needed.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from langchain_core.documents import Document

from app.services.rag.rerank import (
    Reranker,
    _jaccard,
    _tokenize,
    get_reranker,
)


# ── fixtures / helpers ──────────────────────────────────────────────


def _doc(text: str, **meta) -> Document:
    return Document(page_content=text, metadata=meta)


@pytest.fixture
def docs() -> list[Document]:
    return [
        _doc("alpha content about cats", bvid="BV1", title="cats", score=0.9),
        _doc("beta content about dogs", bvid="BV2", title="dogs", score=0.7),
        _doc("gamma content about birds", bvid="BV3", title="birds", score=0.5),
    ]


def _api_response(results: list[dict]) -> MagicMock:
    """Build a fake httpx.Response for the DashScope rerank endpoint."""
    resp = MagicMock()
    resp.raise_for_status.return_value = None
    resp.json.return_value = {"output": {"results": results}}
    return resp


@pytest.fixture
def mock_httpx():
    """Patch httpx.Client; yields the mock client whose .post is configured per-test."""
    with patch("app.services.rag.rerank.httpx.Client") as mock_cls:
        mock_client = MagicMock()
        mock_cls.return_value.__enter__.return_value = mock_client
        mock_cls.return_value.__exit__.return_value = False
        yield mock_client


def _dashscope_reranker() -> Reranker:
    return Reranker(
        strategy="dashscope",
        dashscope_api_key="k",
        dashscope_base_url="http://x",
    )


# ── text helpers ───────────────────────────────────────────────────


class TestHelpers:
    def test_tokenize_lowercases(self) -> None:
        assert _tokenize("Hello WORLD") == {"hello", "world"}

    def test_tokenize_drops_single_char_tokens(self) -> None:
        tokens = _tokenize("a b cc")
        assert "a" not in tokens
        assert "b" not in tokens
        assert "cc" in tokens

    def test_tokenize_empty(self) -> None:
        assert _tokenize("") == set()

    def test_jaccard_identical(self) -> None:
        assert _jaccard({"a"}, {"a"}) == 1.0

    def test_jaccard_disjoint(self) -> None:
        assert _jaccard({"a"}, {"b"}) == 0.0

    def test_jaccard_empty_side(self) -> None:
        assert _jaccard(set(), {"a"}) == 0.0
        assert _jaccard({"a"}, set()) == 0.0

    def test_jaccard_partial(self) -> None:
        # {a,b} vs {a,b,c} -> 2/3
        assert _jaccard({"a", "b"}, {"a", "b", "c"}) == pytest.approx(2 / 3)


# ── null strategy ───────────────────────────────────────────────────


class TestNullStrategy:
    def test_preserves_order_and_truncates(self, docs: list[Document]) -> None:
        out = Reranker(strategy="null").rerank("q", docs, top_k=2)
        assert len(out) == 2
        assert out[0].metadata["bvid"] == "BV1"
        assert out[1].metadata["bvid"] == "BV2"

    def test_top_k_beyond_available(self, docs: list[Document]) -> None:
        out = Reranker(strategy="null").rerank("q", docs, top_k=10)
        assert len(out) == 3

    def test_empty_docs(self) -> None:
        assert Reranker(strategy="null").rerank("q", [], top_k=5) == []


# ── dashscope strategy (gte-rerank-v2 cross-encoder, mocked HTTP) ──


class TestDashScopeStrategy:
    def test_orders_by_relevance_and_writes_score(
        self, mock_httpx, docs: list[Document]
    ) -> None:
        # API returns reversed order: index 2 best, then 0, then 1.
        mock_httpx.post.return_value = _api_response(
            [
                {"index": 2, "relevance_score": 0.95},
                {"index": 0, "relevance_score": 0.80},
                {"index": 1, "relevance_score": 0.10},
            ]
        )
        out = _dashscope_reranker().rerank("query", docs, top_k=3)

        assert [d.metadata["bvid"] for d in out] == ["BV3", "BV1", "BV2"]
        assert out[0].metadata["rerank_score"] == pytest.approx(0.95)

    def test_truncates_to_top_k(self, mock_httpx, docs: list[Document]) -> None:
        mock_httpx.post.return_value = _api_response(
            [
                {"index": 0, "relevance_score": 0.9},
                {"index": 1, "relevance_score": 0.8},
                {"index": 2, "relevance_score": 0.7},
            ]
        )
        out = _dashscope_reranker().rerank("query", docs, top_k=2)
        assert len(out) == 2

    def test_fallback_on_network_error(self, docs: list[Document]) -> None:
        import httpx

        with patch("app.services.rag.rerank.httpx.Client") as mock_cls:
            mock_client = MagicMock()
            mock_cls.return_value.__enter__.return_value = mock_client
            mock_cls.return_value.__exit__.return_value = False
            mock_client.post.side_effect = httpx.HTTPError("boom")

            out = _dashscope_reranker().rerank("query", docs, top_k=2)
        # Never raises; falls back to original order.
        assert len(out) == 2
        assert out[0].metadata["bvid"] == "BV1"

    def test_fallback_on_empty_results(self, mock_httpx, docs: list[Document]) -> None:
        mock_httpx.post.return_value = _api_response([])
        out = _dashscope_reranker().rerank("query", docs, top_k=2)
        assert len(out) == 2
        assert out[0].metadata["bvid"] == "BV1"

    def test_fallback_when_no_api_key(self, docs: list[Document]) -> None:
        r = Reranker(strategy="dashscope", dashscope_api_key="", dashscope_base_url="http://x")
        out = r.rerank("query", docs, top_k=2)
        assert len(out) == 2
        assert out[0].metadata["bvid"] == "BV1"

    def test_fallback_when_empty_query(self, docs: list[Document]) -> None:
        out = _dashscope_reranker().rerank("", docs, top_k=2)
        assert out[0].metadata["bvid"] == "BV1"

    def test_empty_docs(self) -> None:
        assert _dashscope_reranker().rerank("q", [], top_k=5) == []

    def test_does_not_mutate_input(self, mock_httpx, docs: list[Document]) -> None:
        mock_httpx.post.return_value = _api_response(
            [{"index": 0, "relevance_score": 0.9}]
        )
        original = dict(docs[0].metadata)
        _dashscope_reranker().rerank("query", docs, top_k=1)
        assert docs[0].metadata == original
        assert "rerank_score" not in docs[0].metadata


# ── hybrid strategy ────────────────────────────────────────────────


class TestHybridStrategy:
    def test_field_boost_promotes_title_match(self, docs: list[Document]) -> None:
        # query "birds" matches BV3's title only.
        r = Reranker(strategy="hybrid", hybrid_alpha=0.5, hybrid_beta=0.0, hybrid_gamma=0.5)
        out = r.rerank("birds", docs, top_k=3)
        # BV3: 0.5*0.5 + 0.5*1.0 = 0.75  >  BV1: 0.5*0.9 = 0.45
        assert out[0].metadata["bvid"] == "BV3"
        assert out[0].metadata["final_score"] == pytest.approx(0.75)

    def test_attaches_final_score(self, docs: list[Document]) -> None:
        out = Reranker(strategy="hybrid").rerank("cats", docs, top_k=2)
        assert "final_score" in out[0].metadata

    def test_does_not_mutate_input(self, docs: list[Document]) -> None:
        original = dict(docs[0].metadata)
        Reranker(strategy="hybrid").rerank("cats", docs, top_k=2)
        assert "final_score" not in docs[0].metadata
        assert docs[0].metadata == original

    def test_empty_docs(self) -> None:
        assert Reranker(strategy="hybrid").rerank("q", [], top_k=5) == []


# ── mmr strategy ───────────────────────────────────────────────────


class TestMMRStrategy:
    def test_passthrough_when_below_top_k(self, docs: list[Document]) -> None:
        out = Reranker(strategy="mmr").rerank("q", docs, top_k=5)
        assert len(out) == 3

    def test_promotes_diversity_over_duplicates(self) -> None:
        dup_a = _doc("cats cats cats", bvid="BV1", score=0.9)
        dup_b = _doc("cats cats cats", bvid="BV2", score=0.9)  # near-dup of a
        distinct = _doc("dogs dogs dogs", bvid="BV3", score=0.5)
        r = Reranker(strategy="mmr", mmr_lambda=0.5)
        out = r.rerank("q", [dup_a, dup_b, distinct], top_k=2)
        bv = [d.metadata["bvid"] for d in out]
        # Pick the distinct doc + one of the duplicates, not both duplicates.
        assert "BV3" in bv
        assert ("BV1" in bv) ^ ("BV2" in bv)


# ── llm strategy (placeholder) ─────────────────────────────────────


class TestLLMStrategy:
    def test_passthrough(self, docs: list[Document]) -> None:
        out = Reranker(strategy="llm").rerank("q", docs, top_k=2)
        assert len(out) == 2
        assert out[0].metadata["bvid"] == "BV1"


# ── dispatch ────────────────────────────────────────────────────────


class TestDispatch:
    def test_unknown_strategy_per_call_falls_back_to_null(
        self, docs: list[Document]
    ) -> None:
        r = Reranker(strategy="null")
        out = r.rerank("q", docs, top_k=2, strategy="does-not-exist")
        assert len(out) == 2
        assert out[0].metadata["bvid"] == "BV1"

    def test_strategy_override_per_call(self, docs: list[Document]) -> None:
        r = Reranker(strategy="null")
        out = r.rerank("q", docs, top_k=2, strategy="mmr")
        assert len(out) == 2

    def test_invalid_strategy_in_constructor_raises(self) -> None:
        with pytest.raises(ValueError, match="unknown rerank strategy"):
            Reranker(strategy="bogus")

    def test_none_provider_maps_to_null(self, docs: list[Document]) -> None:
        r = Reranker(strategy="none")
        assert r.strategy == "null"
        out = r.rerank("q", docs, top_k=2)
        assert len(out) == 2

    def test_algorithm_failure_falls_back_to_order(
        self, docs: list[Document]
    ) -> None:
        # Any algorithm exception must be swallowed -> original order.
        r = Reranker(strategy="mmr")
        with patch.object(r, "_rerank_mmr", side_effect=RuntimeError("kaboom")):
            out = r.rerank("q", docs, top_k=2)
        assert len(out) == 2
        assert out[0].metadata["bvid"] == "BV1"


# ── from_settings ───────────────────────────────────────────────────


def _fake_settings(**over) -> SimpleNamespace:
    base = dict(
        rerank_enabled=True,
        rerank_provider="dashscope",
        rerank_api_key="k",
        rerank_model="gte-rerank-v2",
        rerank_base_url="http://x",
        rerank_timeout=30,
        rerank_alpha=0.7,
        rerank_beta=0.2,
        rerank_gamma=0.1,
        rerank_lambda=0.7,
        llm_model="gpt-4o",
    )
    base.update(over)
    return SimpleNamespace(**base)


class TestFromSettings:
    def test_disabled_forces_null(self, monkeypatch) -> None:
        monkeypatch.setattr(
            "app.services.rag.rerank.settings",
            _fake_settings(rerank_enabled=False, rerank_provider="dashscope"),
        )
        assert Reranker.from_settings().strategy == "null"

    def test_enabled_uses_provider(self, monkeypatch) -> None:
        monkeypatch.setattr(
            "app.services.rag.rerank.settings",
            _fake_settings(rerank_enabled=True, rerank_provider="mmr"),
        )
        assert Reranker.from_settings().strategy == "mmr"

    def test_dashscope_params_wired(self, monkeypatch) -> None:
        monkeypatch.setattr(
            "app.services.rag.rerank.settings", _fake_settings()
        )
        r = Reranker.from_settings()
        assert r._ds_api_key == "k"
        assert r._ds_model == "gte-rerank-v2"
        assert r._ds_base_url == "http://x"

    def test_real_default_config_enables_dashscope(self) -> None:
        # Reads the real default.yaml (no monkeypatch): rerank.enabled=true
        # + provider=dashscope -> the production default strategy.
        r = Reranker.from_settings()
        assert r.strategy == "dashscope"


# ── get_reranker singleton ─────────────────────────────────────────


class TestGetReranker:
    def test_singleton_is_cached(self, monkeypatch) -> None:
        import app.services.rag.rerank as mod

        monkeypatch.setattr(mod, "_singleton", None)
        monkeypatch.setattr(
            "app.services.rag.rerank.settings",
            _fake_settings(rerank_enabled=False),
        )
        r1 = get_reranker()
        r2 = get_reranker()
        assert r1 is r2

    def test_singleton_reset_picks_up_new_settings(self, monkeypatch) -> None:
        import app.services.rag.rerank as mod

        monkeypatch.setattr(mod, "_singleton", None)
        monkeypatch.setattr(
            "app.services.rag.rerank.settings",
            _fake_settings(rerank_enabled=True, rerank_provider="mmr"),
        )
        assert get_reranker().strategy == "mmr"


# ── legacy.search integration: over-recall + rerank call ────────────


class TestLegacySearchRerankIntegration:
    """Verify the two edits in legacy.search(): over-recall and rerank dispatch.

    RAGService is constructed via __new__ to skip the Milvus connection;
    vectorstore and get_reranker are mocked. No network / Milvus needed.
    """

    def _make_service(self, vectorstore: MagicMock) -> "object":
        from app.services.rag.legacy import RAGService

        svc = RAGService.__new__(RAGService)
        svc.vectorstore = vectorstore
        svc.cloud_backend = None
        return svc

    def test_over_recall_and_rerank_when_enabled(self, monkeypatch) -> None:
        monkeypatch.setattr(
            "app.services.rag.legacy.settings",
            MagicMock(rerank_enabled=True, rerank_top_n=30),
        )
        vectorstore = MagicMock()
        vectorstore.search.return_value = [
            _doc(f"chunk {i}", bvid="BV1", title="t", score=0.5) for i in range(3)
        ]
        fake_reranker = MagicMock()
        fake_reranker.rerank.return_value = [Document(page_content="r", metadata={})]
        monkeypatch.setattr(
            "app.services.rag.rerank.get_reranker", lambda: fake_reranker
        )

        svc = self._make_service(vectorstore)
        out = svc.search("query", k=5, bvids=["BV1"])

        # over-recall: vectorstore was asked for 30, not 5.
        call_kwargs = vectorstore.search.call_args
        assert call_kwargs.kwargs["k"] == 30
        # rerank was called with the user's top_k (5), not the recall count.
        fake_reranker.rerank.assert_called_once()
        assert fake_reranker.rerank.call_args.kwargs["top_k"] == 5
        assert len(out) == 1
        assert out[0].page_content == "r"

    def test_no_over_recall_when_disabled(self, monkeypatch) -> None:
        monkeypatch.setattr(
            "app.services.rag.legacy.settings",
            MagicMock(rerank_enabled=False, rerank_top_n=30),
        )
        vectorstore = MagicMock()
        vectorstore.search.return_value = [
            _doc("chunk", bvid="BV1", title="t", score=0.5)
        ]
        fake_reranker = MagicMock()
        fake_reranker.rerank.side_effect = lambda q, d, top_k: list(d)[:top_k]
        monkeypatch.setattr(
            "app.services.rag.rerank.get_reranker", lambda: fake_reranker
        )

        svc = self._make_service(vectorstore)
        out = svc.search("query", k=5, bvids=["BV1"])

        # disabled -> recall exactly k (5), no over-recall.
        assert vectorstore.search.call_args.kwargs["k"] == 5
        # rerank still called (NullReranker-equivalent slices), returns the docs.
        assert len(out) == 1
