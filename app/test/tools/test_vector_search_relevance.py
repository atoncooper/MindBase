"""Tests for the vector_search tool relevance gate (app/tools/chat/vector_search.py)."""

import pytest
from langchain_core.documents import Document

import app.tools.chat.vector_search as vs
from app.tools.chat.vector_search import VectorSearchTool


class FakeRAGService:
    """Returns the same canned docs for every query, recording calls."""

    def __init__(self, docs):
        self._docs = docs
        self.queries: list[str] = []

    def search(self, query, k, **kwargs):
        self.queries.append(query)
        return list(self._docs)


class FakeSettings:
    def __init__(self, relevance=0.25, similarity=0.35):
        self.rerank_min_relevance_score = relevance
        self.rerank_min_similarity_score = similarity


@pytest.fixture
def fake_settings(monkeypatch):
    monkeypatch.setattr(vs, "settings", FakeSettings())


def _doc(score=None, rerank=None, bvid="BV1", chunk=0):
    meta = {
        "title": f"doc-{bvid}-{chunk}",
        "bvid": bvid,
        "page_index": 0,
        "chunk_index": chunk,
    }
    if score is not None:
        meta["score"] = score
    if rerank is not None:
        meta["rerank_score"] = rerank
    return Document(page_content=f"content of {meta['title']}", metadata=meta)


class TestRelevanceGate:
    @pytest.mark.asyncio
    async def test_offtopic_returns_not_found_and_no_sources(self, fake_settings):
        rag = FakeRAGService(
            [_doc(score=0.62, rerank=0.03, bvid="BV1"),
             _doc(score=0.55, rerank=0.08, bvid="BV2")]
        )
        result = await VectorSearchTool(rag).run(query="PG 和 MySQL 哪个好")
        assert "未找到相关内容" in result["content"]
        assert result["sources"] == []

    @pytest.mark.asyncio
    async def test_relevant_docs_pass_through(self, fake_settings):
        rag = FakeRAGService(
            [_doc(score=0.61, rerank=0.81, bvid="BV1"),
             _doc(score=0.58, rerank=0.66, bvid="BV2")]
        )
        result = await VectorSearchTool(rag).run(query="Jenkins pipeline 怎么配")
        assert len(result["sources"]) == 2
        assert "doc-BV1-0" in result["content"]

    @pytest.mark.asyncio
    async def test_mixed_keeps_only_relevant(self, fake_settings):
        rag = FakeRAGService(
            [_doc(score=0.61, rerank=0.81, bvid="BV1"),
             _doc(score=0.60, rerank=0.04, bvid="BV2")]
        )
        result = await VectorSearchTool(rag).run(query="q")
        assert [s["bvid"] for s in result["sources"]] == ["BV1"]

    @pytest.mark.asyncio
    async def test_boundary_score_passes(self, fake_settings):
        # Floor is inclusive (>=): a doc exactly at the floor survives.
        rag = FakeRAGService([_doc(score=0.5, rerank=0.25, bvid="BV1")])
        result = await VectorSearchTool(rag).run(query="q")
        assert len(result["sources"]) == 1

    @pytest.mark.asyncio
    async def test_cosine_fallback_without_rerank_score(self, fake_settings):
        rag = FakeRAGService([_doc(score=0.62, bvid="BV1"),
                              _doc(score=0.20, bvid="BV2")])
        result = await VectorSearchTool(rag).run(query="q")
        assert [s["bvid"] for s in result["sources"]] == ["BV1"]

    @pytest.mark.asyncio
    async def test_all_below_cosine_floor_no_sources(self, fake_settings):
        rag = FakeRAGService([_doc(score=0.30, bvid="BV1")])
        result = await VectorSearchTool(rag).run(query="q")
        assert result["sources"] == []
        assert "未找到相关内容" in result["content"]

    @pytest.mark.asyncio
    async def test_rewritten_queries_gated_before_fusion(self, fake_settings):
        rag = FakeRAGService([_doc(score=0.5, rerank=0.02, bvid="BV1")])
        result = await VectorSearchTool(rag).run(query="q", _rewritten_queries=["q2"])
        assert len(rag.queries) == 2
        assert result["sources"] == []
        assert "未找到相关内容" in result["content"]

    @pytest.mark.asyncio
    async def test_empty_retrieval_unchanged(self, fake_settings):
        rag = FakeRAGService([])
        result = await VectorSearchTool(rag).run(query="q")
        assert result == {"content": "未找到相关内容。", "sources": []}
