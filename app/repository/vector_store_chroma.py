"""
ChromaDB vector store — implements VectorStoreBackend.

Extracted from RAGService to match the infra-layer pattern.
Default backend (chroma.enabled=true, milvus.enabled=false).
"""

from __future__ import annotations

from typing import Any

from langchain_core.documents import Document
from langchain_chroma import Chroma
from loguru import logger

from app.infra.config import ChromaSection


class ChromaVectorStore:
    """Vector store backed by local ChromaDB (LangChain wrapper)."""

    def __init__(self, config: ChromaSection, embedding_fn: Any):
        self._config = config
        self._embedding_fn = embedding_fn

        self.vectorstore = Chroma(
            collection_name="bilibili_videos",
            embedding_function=embedding_fn,
            persist_directory=config.persist_directory,
        )

    # ── VectorStoreBackend interface ──────────────────────────────

    def add(self, documents: list[Document]) -> int:
        """Add documents in batches of 10. Returns chunk count."""
        if not documents:
            return 0
        ids = self.vectorstore.add_documents(documents)
        return len(ids)

    def search(
        self,
        query: str,
        k: int = 5,
        filter: dict[str, Any] | None = None,
    ) -> list[Document]:
        """Semantic search with optional metadata filter."""
        return self.vectorstore.similarity_search(query, k=k, filter=filter or {})

    def delete(
        self,
        ids: list[str] | None = None,
        where: dict[str, Any] | None = None,
    ) -> int:
        """Delete vectors by ids or metadata filter."""
        collection = self.vectorstore._collection
        before = collection.count()
        if ids:
            collection.delete(ids=ids)
        elif where:
            collection.delete(where=where)
        else:
            return 0
        after = collection.count()
        return before - after

    def count(self) -> int:
        """Return total chunk count."""
        return self.vectorstore._collection.count()

    def close(self) -> None:
        """ChromaDB is file-based, no explicit close needed."""
        pass

    # ── ChromaDB-specific helpers (used by RAGService / vector_page_service) ──

    def delete_by_bvid(self, bvid: str) -> int:
        """Delete all vectors for a bvid."""
        collection = self.vectorstore._collection
        before = collection.count()
        collection.delete(where={"bvid": bvid})
        return before - collection.count()

    def delete_by_page(self, bvid: str, page_index: int) -> int:
        """Delete vectors for a specific bvid + page_index."""
        # ChromaDB multi-condition where has compatibility issues,
        # so filter by bvid first, then by page_index in Python.
        result = self.vectorstore._collection.get(
            where={"bvid": bvid},
            include=["metadatas"],
        )
        ids_to_delete: list[str] = []
        metadatas = result.get("metadatas") or []
        for i, meta in enumerate(metadatas):
            if meta and meta.get("page_index") == page_index:
                ids_to_delete.append(result["ids"][i])

        if ids_to_delete:
            self.vectorstore._collection.delete(ids=ids_to_delete)
        return len(ids_to_delete)

    def count_by_page(self, bvid: str, page_index: int) -> int:
        """Count vectors for a specific bvid + page_index."""
        result = self.vectorstore._collection.get(
            where={"bvid": bvid},
            include=["metadatas"],
        )
        count = 0
        for meta in (result.get("metadatas") or []):
            if meta and meta.get("page_index") == page_index:
                count += 1
        return count

    def get_stats(self) -> dict:
        """Collection stats — total chunks, unique bvids."""
        try:
            total = self.vectorstore._collection.count()
            result = self.vectorstore._collection.get(include=["metadatas"])
            bvids: set[str] = set()
            for meta in (result.get("metadatas") or []):
                if meta and meta.get("bvid"):
                    bvids.add(meta["bvid"])
            return {
                "total_chunks": total,
                "total_videos": len(bvids),
                "collection_name": "bilibili_videos",
            }
        except Exception as e:
            logger.warning(f"[CHROMA] get_stats failed: {e}")
            return {
                "total_chunks": 0,
                "total_videos": 0,
                "collection_name": "bilibili_videos",
            }

    def clear(self) -> None:
        """Delete all vectors in the collection."""
        self.vectorstore._collection.delete(where={})
        logger.info("[CHROMA] collection cleared")
