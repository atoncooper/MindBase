"""VectorSearchTool - semantic search over the knowledge base."""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from functools import partial
from typing import Any

from langchain_core.documents import Document

from app.tools import ToolDeps, register_tool

logger = logging.getLogger(__name__)


@register_tool
class VectorSearchTool:
    """Semantic vector search over the knowledge base.

    The LLM calls this tool when it needs to retrieve specific content
    from the user's B站 video collection or cloud drive documents.
    """

    def __init__(self, rag_service: Any) -> None:
        self._rag = rag_service

    @classmethod
    def from_deps(cls, deps: ToolDeps) -> "VectorSearchTool | None":
        if deps.rag is None:
            return None
        return cls(deps.rag)

    @property
    def name(self) -> str:
        return "vector_search"

    @property
    def description(self) -> str:
        return (
            "从知识库中语义检索相关内容。**调用前必须先优化 query**：\n"
            "1. 指代消解：把「它」「那个」替换为具体实体名\n"
            "2. 上下文补全：结合对话历史补全省略信息\n"
            "3. 具体化：模糊问题变精确，不要泛泛而搜\n"
            "4. 多视角：分多次调用不同 query 覆盖不同角度\n"
            "适用于深度问题、具体观点查找、需要内容支撑的回答。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "用于语义检索的查询文本，应尽量具体和聚焦",
                },
                "k": {
                    "type": "integer",
                    "description": "返回结果数量，默认5",
                },
            },
            "required": ["query"],
        }

    async def run(self, *, query: str, k: int = 5, **kwargs: Any) -> dict[str, Any]:
        """Execute vector search.

        Returns a dict ``{"content": <text>, "sources": [<source dict>, ...]}``
        so the runtime can preserve structured sources alongside the text
        result that goes back to the LLM. ``AgentRuntime`` lifts ``sources``
        into ``ToolMessage.additional_kwargs`` and the chat graph
        accumulates them into ``state.search_results``.

        When ``_rewritten_queries`` is injected (by inject_context via the
        runtime), multi-path retrieval runs the LLM query plus each rewrite
        in parallel and merges/dedups the results.
        """
        k = min(max(k, 1), 50)  # Clamp to [1, 50]
        bvids = kwargs.get("_bvids")
        workspace_pages = kwargs.get("_workspace_pages")
        uid = kwargs.get("_uid")
        upload_uuids = kwargs.get("_upload_uuids")
        rewritten_queries = kwargs.get("_rewritten_queries") or []

        # Multi-path: LLM query + rewritten queries (dedup, skip empty).
        # dict.fromkeys preserves order and drops intra-list duplicates.
        all_queries = list(
            dict.fromkeys(
                q for q in [query, *rewritten_queries] if q and q.strip()
            )
        )

        loop = asyncio.get_running_loop()
        tasks = [
            loop.run_in_executor(
                None,
                partial(
                    self._rag.search,
                    q,
                    k,
                    bvids=bvids or None,
                    workspace_pages=workspace_pages,
                    uid=uid,
                    upload_uuids=upload_uuids,
                ),
            )
            for q in all_queries
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Collect per-query result lists (each already rerank-sorted by
        # RAGService.search) for rank-based fusion.
        per_query_docs: list[list[Document]] = []
        for q, res in zip(all_queries, results):
            if isinstance(res, Exception):
                logger.warning(
                    "[vector_search] sub-query failed: %s", (q or "")[:50], exc_info=res
                )
                continue
            per_query_docs.append(res)

        # Fuse: RRF for multi-path (robust to per-query score-scale
        # differences, implicitly honors reranker ordering); passthrough for
        # single query.
        if len(per_query_docs) > 1:
            docs = _rrf_fuse(per_query_docs, k=k)
        elif per_query_docs:
            docs = per_query_docs[0]
        else:
            docs = []

        if not docs:
            return {"content": "未找到相关内容。", "sources": []}

        return {
            "content": _format_docs(docs),
            "sources": _extract_sources(docs),
        }


_RRF_K = 60  # standard Reciprocal Rank Fusion constant


def _doc_key(doc: Document) -> str:
    """Chunk identity (owner + page + chunk index) for dedup."""
    meta = doc.metadata
    owner = meta.get("bvid") or meta.get("upload_uuid", "")
    return f"{owner}:{meta.get('page_index', 0)}:{meta.get('chunk_index', 0)}"


def _rrf_fuse(per_query_docs: list[list[Document]], k: int) -> list[Document]:
    """Fuse multi-path results via Reciprocal Rank Fusion.

    Each doc scores ``sum(1/(rrf_k + rank))`` across queries where it appears.
    Rank-based fusion is robust to per-query score-scale differences (different
    query embeddings yield different COSINE distance distributions) and
    implicitly honors the reranker ordering - each per-query list is already
    rerank-sorted by ``RAGService.search``.
    """
    scores: dict[str, float] = defaultdict(float)
    doc_map: dict[str, Document] = {}
    for docs in per_query_docs:
        for rank, doc in enumerate(docs):
            key = _doc_key(doc)
            scores[key] += 1.0 / (_RRF_K + rank)
            if key not in doc_map:
                doc_map[key] = doc
    ranked = sorted(doc_map.values(), key=lambda d: scores[_doc_key(d)], reverse=True)
    return ranked[:k]


def _format_docs(docs: list[Document], per_video_k: int = 3) -> str:
    """Format documents into readable text, deduplicating by video."""
    grouped: dict[str, list[Document]] = defaultdict(list)
    for doc in docs:
        meta = doc.metadata
        key = meta.get("bvid") or meta.get("upload_uuid", "unknown")
        grouped[key].append(doc)

    parts: list[str] = []
    for key, group in grouped.items():
        sorted_group = sorted(
            group,
            key=lambda d: d.metadata.get("score", 0),
            reverse=True,
        )
        for doc in sorted_group[:per_video_k]:
            meta = doc.metadata
            title = meta.get("title", "未知标题")
            content = doc.page_content.strip()
            score = meta.get("score", 0)
            if content:
                parts.append(f"【{title}】(相关度: {score:.2f})\n{content}")

    return "\n\n---\n\n".join(parts) if parts else "未找到相关内容。"


def _extract_sources(docs: list[Document]) -> list[dict[str, Any]]:
    """Extract structured source metadata from retrieved documents.

    Deduplicates by ``bvid`` (or ``upload_uuid`` for cloud docs). Keeps the
    first occurrence - callers receive the full set so the chat graph can
    merge sources from multiple search calls.
    """
    seen: set[str] = set()
    sources: list[dict[str, Any]] = []
    for doc in docs:
        meta = doc.metadata
        bvid = meta.get("bvid") or ""
        upload_uuid = meta.get("upload_uuid") or ""
        key = bvid or upload_uuid
        if not key or key in seen:
            continue
        seen.add(key)
        source: dict[str, Any] = {
            "title": meta.get("title", "未知标题"),
            "score": meta.get("score", 0),
        }
        if bvid:
            source["bvid"] = bvid
            source["url"] = meta.get(
                "url", f"https://www.bilibili.com/video/{bvid}"
            )
            if meta.get("page_index") is not None:
                source["page_index"] = meta.get("page_index")
        if upload_uuid:
            source["upload_uuid"] = upload_uuid
        sources.append(source)
    return sources
