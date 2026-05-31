"""
Vector store abstraction — Protocol + factory for swappable backends.

Usage:
    from app.infra.vector_store import get_vector_store

    store = get_vector_store(embedding_fn)
    await store.add(docs)
    results = await store.search("query", k=5)
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from langchain_core.documents import Document


@runtime_checkable
class VectorStoreBackend(Protocol):
    """Protocol for swappable vector database backends."""

    def add(self, documents: list[Document]) -> int:
        """Add documents with embeddings.  Returns chunk count."""
        ...

    def search(
        self,
        query: str,
        k: int = 5,
        filter: dict[str, Any] | None = None,
    ) -> list[Document]:
        """Semantic similarity search.  Returns top-k Documents with metadata."""
        ...

    def delete(self, ids: list[str] | None = None, where: dict[str, Any] | None = None) -> int:
        """Delete vectors by ids or metadata filter.  Returns count deleted."""
        ...

    def count(self) -> int:
        """Return total vector count in the collection."""
        ...

    def delete_by_bvid(self, bvid: str) -> int:
        """Delete all vectors for a bvid. Returns count deleted."""
        ...

    def delete_by_page(self, bvid: str, page_index: int) -> int:
        """Delete vectors for a bvid + page_index. Returns count deleted."""
        ...

    def count_by_page(self, bvid: str, page_index: int) -> int:
        """Count vectors for a bvid + page_index."""
        ...

    def get_stats(self) -> dict:
        """Collection stats: total_chunks, total_videos, collection_name."""
        ...

    def clear(self) -> None:
        """Delete all vectors in the collection."""
        ...

    def close(self) -> None:
        """Release backend resources."""
        ...


# ── Factory ────────────────────────────────────────────────────────


def get_vector_store(embedding_fn: Any) -> VectorStoreBackend:
    """Return the configured vector store backend.

    The decision is based on config.milvus.enabled:
      - True  → MilvusVectorStore
      - False → ChromaVectorStore (default)
    """
    from app.infra.config import config

    if config.milvus.enabled:
        from app.repository.vector_store_milvus import MilvusVectorStore
        return MilvusVectorStore(config.milvus, embedding_fn)

    from app.repository.vector_store_chroma import ChromaVectorStore
    return ChromaVectorStore(config.chroma, embedding_fn)
