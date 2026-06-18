"""Reranker abstraction + DashScope gte-rerank-v2 implementation.

Two-stage retrieval pattern:

    embedding search → over-recall N=30 → rerank → cut to K=5 → consumer

Why a separate stage:
- Embedding similarity is fast but coarse — chunks that share topical
  vocabulary score high even when they don't actually answer the
  question. A rerank model trained on (query, document, label) triples
  fixes this with a much smaller candidate pool.
- Over-recall is mandatory: rerank can only choose among what the
  retriever surfaces. K=5 with no over-recall makes rerank a no-op.

The reranker runs synchronously in the search() thread because gte-rerank-v2
is fast (~30-60ms for N=30) and adding async plumbing for one HTTP call
would not pay off. If a future provider is slower, swap to async there.

Failure handling: any exception falls back to the original embedding
order. The fallback is logged at WARNING with a stable prefix so it
shows up in run reports / log scrapes.
"""

from __future__ import annotations

from typing import Any, Optional, Protocol, Sequence

import httpx
from langchain_core.documents import Document
from loguru import logger

from app.config import settings


_LOG_PREFIX = "[RERANK]"


class Reranker(Protocol):
    """Strategy interface for reranking retrieved documents."""

    name: str

    def rerank(
        self, query: str, docs: Sequence[Document], top_k: int
    ) -> list[Document]:
        """Return the top-``top_k`` documents in rerank order.

        Implementations MUST NOT raise; on internal failure they MUST
        return ``list(docs)[:top_k]`` and log the reason.
        """
        ...


class NullReranker:
    """Passthrough reranker — preserves the embedding order.

    Used when ``rerank.enabled = false`` so callers can use the same
    code path either way.
    """

    name = "null"

    def rerank(
        self, query: str, docs: Sequence[Document], top_k: int
    ) -> list[Document]:
        return list(docs)[:top_k]


class DashScopeReranker:
    """gte-rerank-v2 via DashScope native REST API.

    Endpoint contract (POST {base_url}/services/rerank/text-rerank/text-rerank):
        request:  {"model": "...", "input": {"query": "...", "documents": ["..."]}}
        response: {"output": {"results": [{"index": int, "relevance_score": float}, ...]}}

    The ``index`` field references the position in the request's
    ``documents`` list, NOT a stable doc id — we map back into ``docs``
    by that index.
    """

    name = "dashscope"

    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str,
        timeout: int,
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout

    def _truncate(self, text: str, limit: int = 1500) -> str:
        # The rerank model has its own context limit (~512 tokens for
        # gte-rerank-v2); long chunks waste budget without helping. Hard
        # cut at 1500 chars keeps the call fast and the relevance signal
        # focused on the chunk's lead.
        if len(text) <= limit:
            return text
        return text[:limit]

    def rerank(
        self, query: str, docs: Sequence[Document], top_k: int
    ) -> list[Document]:
        docs_list = list(docs)
        if not docs_list:
            return []
        if not query or not query.strip():
            return docs_list[:top_k]
        if not self._api_key:
            logger.warning(
                "{} api_key missing → fallback to embedding order", _LOG_PREFIX
            )
            return docs_list[:top_k]

        documents = [self._truncate(d.page_content or "") for d in docs_list]
        url = f"{self._base_url}/services/rerank/text-rerank/text-rerank"
        payload = {
            "model": self._model,
            "input": {"query": query, "documents": documents},
            "parameters": {"top_n": top_k, "return_documents": False},
        }
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

        try:
            with httpx.Client(timeout=self._timeout) as client:
                resp = client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data: dict[str, Any] = resp.json()
        except httpx.HTTPStatusError as exc:
            logger.warning(
                "{} HTTP {} → fallback. body={}",
                _LOG_PREFIX,
                exc.response.status_code,
                exc.response.text[:200],
            )
            return docs_list[:top_k]
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning(
                "{} call failed ({}) → fallback", _LOG_PREFIX, type(exc).__name__
            )
            return docs_list[:top_k]

        results = (data.get("output") or {}).get("results") or []
        if not isinstance(results, list) or not results:
            logger.warning(
                "{} empty results → fallback. raw_keys={}",
                _LOG_PREFIX,
                list(data.keys()),
            )
            return docs_list[:top_k]

        ordered: list[Document] = []
        seen: set[int] = set()
        for item in results:
            idx = item.get("index") if isinstance(item, dict) else None
            if not isinstance(idx, int) or idx < 0 or idx >= len(docs_list):
                continue
            if idx in seen:
                continue
            seen.add(idx)
            score = item.get("relevance_score")
            doc = docs_list[idx]
            # Surface rerank score in metadata so downstream (reporter,
            # logs) can see the picked relevance.
            new_meta = dict(doc.metadata or {})
            if isinstance(score, (int, float)):
                new_meta["rerank_score"] = float(score)
            ordered.append(Document(page_content=doc.page_content, metadata=new_meta))
            if len(ordered) >= top_k:
                break

        if not ordered:
            return docs_list[:top_k]

        logger.info(
            "{} reranked: in={} out={} top_score={}",
            _LOG_PREFIX,
            len(docs_list),
            len(ordered),
            ordered[0].metadata.get("rerank_score"),
        )
        return ordered


_singleton: Optional[Reranker] = None


def get_reranker() -> Reranker:
    """Return the configured reranker. Cached process-wide.

    Resets are not supported — config changes require a restart, matching
    how RAGService and the embeddings client are handled.
    """

    global _singleton
    if _singleton is not None:
        return _singleton

    if not settings.rerank_enabled:
        _singleton = NullReranker()
        return _singleton

    provider = settings.rerank_provider.lower()
    if provider == "dashscope":
        _singleton = DashScopeReranker(
            api_key=settings.rerank_api_key,
            model=settings.rerank_model,
            base_url=settings.rerank_base_url,
            timeout=settings.rerank_timeout,
        )
    elif provider == "none":
        _singleton = NullReranker()
    else:
        logger.warning(
            "{} unknown provider {!r} → using null reranker",
            _LOG_PREFIX,
            provider,
        )
        _singleton = NullReranker()
    return _singleton
