"""VectorSearchTool — semantic search over the knowledge base."""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Any

from langchain_core.documents import Document

logger = logging.getLogger(__name__)


class VectorSearchTool:
    """Semantic vector search over the knowledge base.

    The LLM calls this tool when it needs to retrieve specific content
    from the user's B站 video collection or cloud drive documents.
    """

    def __init__(self, rag_service: Any) -> None:
        self._rag = rag_service

    @property
    def name(self) -> str:
        return "vector_search"

    @property
    def description(self) -> str:
        return (
            "从知识库中检索与查询语义相关的内容片段。"
            "适用于需要具体内容的深度问题，例如「XX讲了什么」「XX的核心观点」。"
            "可以多次调用，每次使用不同的 query 来收集更多信息。"
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

    async def run(self, *, query: str, k: int = 5, **kwargs: Any) -> str:
        """Execute vector search and return formatted results."""
        k = min(max(k, 1), 50)  # Clamp to [1, 50]
        bvids = kwargs.get("_bvids")
        workspace_pages = kwargs.get("_workspace_pages")
        uid = kwargs.get("_uid")

        loop = asyncio.get_running_loop()
        docs = await loop.run_in_executor(
            None,
            self._rag.search,
            query, k,
            bvids if bvids else None,
            workspace_pages,
            uid,
        )

        if not docs:
            return "未找到相关内容。"

        return _format_docs(docs)


def _format_docs(docs: list[Document], per_video_k: int = 3) -> str:
    """Format documents into readable text, deduplicating by video."""
    grouped: dict[str, list[Document]] = defaultdict(list)
    for doc in docs:
        meta = doc.metadata if hasattr(doc, "metadata") else {}
        key = meta.get("bvid") or meta.get("upload_uuid", "unknown")
        grouped[key].append(doc)

    parts: list[str] = []
    for key, group in grouped.items():
        sorted_group = sorted(
            group,
            key=lambda d: d.metadata.get("score", 0) if hasattr(d, "metadata") else 0,
            reverse=True,
        )
        for doc in sorted_group[:per_video_k]:
            meta = doc.metadata if hasattr(doc, "metadata") else {}
            title = meta.get("title", "未知标题")
            content = doc.page_content.strip() if hasattr(doc, "page_content") else str(doc).strip()
            score = meta.get("score", 0)
            if content:
                parts.append(f"【{title}】(相关度: {score:.2f})\n{content}")

    return "\n\n---\n\n".join(parts) if parts else "未找到相关内容。"
