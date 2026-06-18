"""Package wrapper for legacy RAG service."""

from __future__ import annotations

from typing import Optional

from .legacy import RAGService

# Singleton RAGService — avoids re-initializing embeddings/vector store on every request
_rag_service: Optional[RAGService] = None


def get_rag_service() -> RAGService:
    global _rag_service
    if _rag_service is None:
        from app.main import app

        manager = getattr(app.state, "api_key_manager", None)
        # When Milvus is enabled, pass embedding fn via factory
        _rag_service = RAGService(api_key_manager=manager)
    return _rag_service


__all__ = [
    "RAGService",
    "get_rag_service",
]
