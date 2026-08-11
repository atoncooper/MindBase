"""
Query Rewriter Service

Query 改写服务：对用户 query 进行改写，提升向量检索召回质量。
"""
from app.services.query.rewriter import QueryRewriter
from app.services.query.types import (
    RewriteType,
    RewriteResult,
    RewrittenQuery,
    BaseMetadata,
    StepBackMetadata,
    SubQueryMetadata,
    MetadataType,
    CONFIDENCE_THRESHOLD,
)

_rewriter: "QueryRewriter | None" = None


def get_rewriter() -> "QueryRewriter":
    """Return the process-wide QueryRewriter singleton (lazy-init).

    Lets DBChatDeps / inject_context access the rewriter without a FastAPI
    app.state dependency.
    """
    global _rewriter
    if _rewriter is None:
        _rewriter = QueryRewriter()
    return _rewriter


__all__ = [
    "QueryRewriter",
    "get_rewriter",
    "RewriteType",
    "RewriteResult",
    "RewrittenQuery",
    "BaseMetadata",
    "StepBackMetadata",
    "SubQueryMetadata",
    "MetadataType",
    "CONFIDENCE_THRESHOLD",
]
