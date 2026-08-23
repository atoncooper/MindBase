"""KgSearchTool 门控与降级单测。

不依赖真实 Neo4j/Milvus：不可用时 from_deps 应返回 None（工具不注册），
run() 失败应返回提示文本而非抛异常（ReAct 循环容错）。
"""

import sys
from types import SimpleNamespace

from app.tools._deps import ToolDeps
from app.tools.chat.kg_search import KgSearchTool
from app.services.kg.retriever import KgRetrievalResult


def _unavailable_kg():
    """模拟 Neo4j 未连接的 KgService。"""
    svc = SimpleNamespace()
    svc.is_available = lambda: False

    class _R:
        def is_available(self):
            return False

    retriever = _R()

    async def _retrieve(*a, **kw):
        raise RuntimeError("neo4j down")

    retriever.retrieve = _retrieve
    svc.retriever = retriever
    return svc


def _available_kg(content: str, sources: list):
    """模拟可用的 KgService，retrieve 返回真实 KgRetrievalResult。"""
    svc = SimpleNamespace()
    svc.is_available = lambda: True

    class _R:
        def __init__(self):
            self.last_call = None
            self._content = content
            self._sources = sources

        def is_available(self):
            return True

        async def retrieve(self, query, bvids=None, k=8):
            self.last_call = (query, bvids, k)
            return KgRetrievalResult(
                content=self._content,
                sources=self._sources,
                entity_count=3,
                evidence_count=5,
            )

    retriever = _R()
    svc.retriever = retriever
    return svc, retriever


class TestGating:
    def test_from_deps_none_when_unavailable(self):
        assert KgSearchTool.from_deps(ToolDeps(kg=_unavailable_kg())) is None

    def test_from_deps_none_when_missing(self):
        assert KgSearchTool.from_deps(ToolDeps(kg=None)) is None

    def test_tool_metadata(self):
        tool = KgSearchTool(_unavailable_kg())
        assert tool.name == "kg_search"
        params = tool.parameters()
        assert params["required"] == ["query"]
        assert "知识图谱" in tool.description


class TestRun:
    def test_run_degrades_on_failure(self):
        """Neo4j 故障时 run 返回提示文本，绝不抛异常打断 ReAct 循环。"""
        import asyncio

        tool = KgSearchTool(_unavailable_kg())
        out = asyncio.run(tool.run(query="RAG", _bvids=["BV1xx411c7mD"]))
        assert out["sources"] == []
        assert out["content"]

    def test_run_passes_scope_and_formats_result(self):
        import asyncio

        svc, retriever = _available_kg(
            "实体卡片",
            [{"title": "T", "score": 0.9, "bvid": "BV1", "url": "u"}],
        )
        tool = KgSearchTool(svc)
        out = asyncio.run(tool.run(query="LangChain 对比", _bvids=["BV1", "BV2"], k=5))
        assert out == {"content": "实体卡片", "sources": [{"title": "T", "score": 0.9, "bvid": "BV1", "url": "u"}]}
        # 隐式作用域 bvids 必须传给检索器；k 被透传
        assert retriever.last_call == ("LangChain 对比", ["BV1", "BV2"], 5)

    def test_run_empty_result_message(self):
        import asyncio

        svc, _ = _available_kg("", [])
        tool = KgSearchTool(svc)
        out = asyncio.run(tool.run(query="不存在的东西"))
        assert "没有找到" in out["content"]
        assert out["sources"] == []

    def test_run_k_clamped(self):
        import asyncio

        svc, retriever = _available_kg("x", [])
        tool = KgSearchTool(svc)
        asyncio.run(tool.run(query="q", k=999))
        assert retriever.last_call[2] <= 20


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
