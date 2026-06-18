"""Unit tests for VectorSearchTool (app/tools/chat/vector_search.py).

Covers the dict return shape that the ReAct runtime depends on:
``{"content": str, "sources": list[dict]}``. The ``sources`` list is
forwarded to ``ToolMessage.additional_kwargs`` and merged into
``state.search_results`` by ``runtime_dispatch``, so getting the shape
right is what keeps citations in the SSE stream.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from langchain_core.documents import Document

from app.tools.chat.vector_search import (
    VectorSearchTool,
    _extract_sources,
    _format_docs,
)
from app.tools import ToolDeps


def _doc(text: str, **meta) -> Document:
    return Document(page_content=text, metadata=meta)


# ---------------------------------------------------------------------------
# from_deps
# ---------------------------------------------------------------------------


class TestFromDeps:
    def test_returns_none_without_rag(self) -> None:
        deps = ToolDeps(rag=None)
        assert VectorSearchTool.from_deps(deps) is None

    def test_returns_instance_with_rag(self) -> None:
        rag = MagicMock()
        deps = ToolDeps(rag=rag)
        tool = VectorSearchTool.from_deps(deps)
        assert isinstance(tool, VectorSearchTool)


# ---------------------------------------------------------------------------
# run() — return shape and clamping
# ---------------------------------------------------------------------------


class TestRunReturnShape:
    @pytest.mark.asyncio
    async def test_returns_dict_with_content_and_sources(self) -> None:
        rag = MagicMock()
        rag.search = MagicMock(
            return_value=[
                _doc("片段A", bvid="BV1xx", title="A", score=0.9),
                _doc("片段B", bvid="BV2yy", title="B", score=0.8),
            ]
        )
        tool = VectorSearchTool(rag)

        out = await tool.run(query="哲学")

        assert isinstance(out, dict)
        assert set(out.keys()) == {"content", "sources"}
        assert isinstance(out["content"], str)
        assert isinstance(out["sources"], list)
        assert len(out["sources"]) == 2

    @pytest.mark.asyncio
    async def test_empty_docs_returns_empty_sources(self) -> None:
        rag = MagicMock()
        rag.search = MagicMock(return_value=[])
        tool = VectorSearchTool(rag)

        out = await tool.run(query="无结果")

        assert out == {"content": "未找到相关内容。", "sources": []}

    @pytest.mark.asyncio
    async def test_k_clamps_to_one_minimum(self) -> None:
        rag = MagicMock()
        rag.search = MagicMock(return_value=[])
        tool = VectorSearchTool(rag)

        await tool.run(query="q", k=0)

        # rag.search positional args: (query, k, bvids, workspace_pages, uid)
        called_k = rag.search.call_args.args[1]
        assert called_k == 1

    @pytest.mark.asyncio
    async def test_k_clamps_to_fifty_maximum(self) -> None:
        rag = MagicMock()
        rag.search = MagicMock(return_value=[])
        tool = VectorSearchTool(rag)

        await tool.run(query="q", k=10000)

        called_k = rag.search.call_args.args[1]
        assert called_k == 50

    @pytest.mark.asyncio
    async def test_negative_k_clamps_to_one(self) -> None:
        rag = MagicMock()
        rag.search = MagicMock(return_value=[])
        tool = VectorSearchTool(rag)

        await tool.run(query="q", k=-3)

        called_k = rag.search.call_args.args[1]
        assert called_k == 1


# ---------------------------------------------------------------------------
# run() — implicit kwargs forwarded to rag.search
# ---------------------------------------------------------------------------


class TestImplicitKwargs:
    @pytest.mark.asyncio
    async def test_passes_bvids_and_workspace_and_uid(self) -> None:
        rag = MagicMock()
        rag.search = MagicMock(return_value=[])
        tool = VectorSearchTool(rag)

        await tool.run(
            query="q",
            k=5,
            _bvids=["BV1", "BV2"],
            _workspace_pages=[{"bvid": "BV1", "cid": 100}],
            _uid=42,
        )

        args = rag.search.call_args.args
        # search(query, k, bvids, workspace_pages, uid)
        assert args[0] == "q"
        assert args[1] == 5
        assert args[2] == ["BV1", "BV2"]
        assert args[3] == [{"bvid": "BV1", "cid": 100}]
        assert args[4] == 42

    @pytest.mark.asyncio
    async def test_empty_bvids_passes_none(self) -> None:
        """Empty list should become None so rag.search treats it as 'no filter'."""
        rag = MagicMock()
        rag.search = MagicMock(return_value=[])
        tool = VectorSearchTool(rag)

        await tool.run(query="q", _bvids=[])

        bvids_arg = rag.search.call_args.args[2]
        assert bvids_arg is None

    @pytest.mark.asyncio
    async def test_missing_kwargs_pass_none(self) -> None:
        rag = MagicMock()
        rag.search = MagicMock(return_value=[])
        tool = VectorSearchTool(rag)

        await tool.run(query="q")

        args = rag.search.call_args.args
        assert args[2] is None  # _bvids
        assert args[3] is None  # _workspace_pages
        assert args[4] is None  # _uid


# ---------------------------------------------------------------------------
# _extract_sources — dedup + URL/page_index handling
# ---------------------------------------------------------------------------


class TestExtractSources:
    def test_dedup_by_bvid(self) -> None:
        docs = [
            _doc("a1", bvid="BV1", title="T1", score=0.9),
            _doc("a2", bvid="BV1", title="T1", score=0.8),  # duplicate bvid
            _doc("b1", bvid="BV2", title="T2", score=0.7),
        ]
        sources = _extract_sources(docs)

        assert len(sources) == 2
        bvids = [s["bvid"] for s in sources]
        assert bvids == ["BV1", "BV2"]

    def test_bvid_source_has_url_and_optional_page_index(self) -> None:
        docs = [
            _doc("x", bvid="BV1", title="T1", score=0.9, page_index=2),
            _doc("y", bvid="BV2", title="T2", score=0.5),
        ]
        sources = _extract_sources(docs)

        assert sources[0]["url"] == "https://www.bilibili.com/video/BV1"
        assert sources[0]["page_index"] == 2
        # No page_index in metadata → field absent
        assert "page_index" not in sources[1]

    def test_custom_url_metadata_preserved(self) -> None:
        docs = [_doc("x", bvid="BV1", title="T1", score=0.9, url="custom://example")]
        sources = _extract_sources(docs)
        assert sources[0]["url"] == "custom://example"

    def test_cloud_doc_uses_upload_uuid(self) -> None:
        docs = [
            _doc("c1", upload_uuid="uuid-1", title="云盘文档", score=0.95),
            _doc("c2", upload_uuid="uuid-1", title="云盘文档", score=0.7),
        ]
        sources = _extract_sources(docs)

        assert len(sources) == 1
        assert sources[0]["upload_uuid"] == "uuid-1"
        assert "bvid" not in sources[0]
        assert "url" not in sources[0]

    def test_skip_doc_without_identifier(self) -> None:
        docs = [_doc("x", title="无标识", score=0.5)]
        sources = _extract_sources(docs)
        assert sources == []

    def test_mixed_bvid_and_cloud(self) -> None:
        docs = [
            _doc("a", bvid="BV1", title="T1", score=0.9),
            _doc("b", upload_uuid="u1", title="C1", score=0.85),
        ]
        sources = _extract_sources(docs)

        assert len(sources) == 2
        assert sources[0]["bvid"] == "BV1"
        assert sources[1]["upload_uuid"] == "u1"


# ---------------------------------------------------------------------------
# _format_docs — grouping + per-video cap
# ---------------------------------------------------------------------------


class TestFormatDocs:
    def test_returns_fallback_when_empty(self) -> None:
        assert _format_docs([]) == "未找到相关内容。"

    def test_groups_and_caps_per_video(self) -> None:
        docs = [
            _doc("c1", bvid="BV1", title="T1", score=0.9),
            _doc("c2", bvid="BV1", title="T1", score=0.8),
            _doc("c3", bvid="BV1", title="T1", score=0.7),
            _doc("c4", bvid="BV1", title="T1", score=0.6),  # over cap
            _doc("d1", bvid="BV2", title="T2", score=0.95),
        ]
        text = _format_docs(docs, per_video_k=3)

        assert "T1" in text
        assert "T2" in text
        assert "c4" not in text  # capped out

    def test_orders_by_score_desc_within_group(self) -> None:
        docs = [
            _doc("low", bvid="BV1", title="T1", score=0.1),
            _doc("high", bvid="BV1", title="T1", score=0.9),
        ]
        text = _format_docs(docs, per_video_k=2)
        # higher score should appear first
        assert text.index("high") < text.index("low")
