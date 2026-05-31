"""Package wrapper for legacy RAG service plus new agentic modules."""

from __future__ import annotations

from typing import Optional

from .legacy import RAGService
from .agentic import (
    AgenticAnswer,
    AgenticRAGService,
    AgenticState,
    ReasoningStep,
    get_agentic_rag_service,
)

# Singleton RAGService — avoids re-initializing embeddings/vector store on every request
_rag_service: Optional[RAGService] = None


def get_rag_service() -> RAGService:
    global _rag_service
    if _rag_service is None:
        from app.main import app
        manager = getattr(app.state, "api_key_manager", None)
        # When Milvus is enabled, pass embedding fn via factory; otherwise Chroma default
        _rag_service = RAGService(api_key_manager=manager)
    return _rag_service


__all__ = [
    "RAGService",
    "AgenticAnswer",
    "AgenticRAGService",
    "AgenticState",
    "ReasoningStep",
    "get_agentic_rag_service",
    "get_rag_service",
]
