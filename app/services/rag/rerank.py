"""Reranker - strategy pattern: one class bundling multiple rerank
algorithms, dispatched by strategy name.

Two-stage retrieval:

    embedding recall (coarse, fast)  ->  rerank (fine, accurate)  ->  top-k

This module keeps every rerank algorithm inside a single ``Reranker``
class. ``rerank()`` is the dispatch entry point: it routes to the
algorithm selected by ``strategy`` (set at construction, or overridden
per-call), so callers can switch algorithms dynamically without
changing the call site.

Strategies:
    null      - passthrough, preserves embedding order
    dashscope - cross-encoder gte-rerank-v2 via DashScope REST API
    hybrid    - weighted blend (embedding sim + field boost), no API
    mmr       - maximal marginal relevance, promotes diversity
    llm       - LLM-as-reranker (placeholder, passthrough)

Contract: ``rerank()`` NEVER raises; on any internal failure it falls
back to ``list(docs)[:top_k]`` so the retrieval path never breaks.

Note on ``score``: hybrid / mmr assume ``metadata["score"]`` is a
similarity (larger = better, e.g. COSINE / IP). If the Milvus metric is
L2 the sign must be inverted before blending.
"""

from __future__ import annotations

import re
from typing import Optional, Sequence

import httpx
from langchain_core.documents import Document
from loguru import logger

from app.config import settings

_LOG_PREFIX = "[RERANK]"
_TOKEN_RE = re.compile(r"\w+", re.UNICODE)


def _tokenize(text: str) -> set[str]:
    """Lowercase token set (length > 1) for cheap text similarity."""
    return {t for t in _TOKEN_RE.findall((text or "").lower()) if len(t) > 1}


def _jaccard(a: set[str], b: set[str]) -> float:
    """Jaccard overlap in [0, 1]; 0 when either side is empty."""
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


class Reranker:
    """One class, multiple rerank algorithms, dispatched by strategy name.

    Usage:
        r = Reranker.from_settings()                     # strategy from config
        docs = r.rerank(query, docs, top_k=5)           # use configured strategy
        docs = r.rerank(query, docs, 5, strategy="mmr")  # override per-call
    """

    STRATEGIES = ("null", "dashscope", "hybrid", "mmr", "llm")

    def __init__(
        self,
        strategy: str = "null",
        *,
        dashscope_api_key: str = "",
        dashscope_model: str = "gte-rerank-v2",
        dashscope_base_url: str = "",
        dashscope_timeout: int = 30,
        hybrid_alpha: float = 0.7,
        hybrid_beta: float = 0.2,
        hybrid_gamma: float = 0.1,
        mmr_lambda: float = 0.7,
        llm_model: str = "",
        llm_max_candidates: int = 10,
    ) -> None:
        strategy = (strategy or "null").lower()
        if strategy == "none":
            strategy = "null"
        if strategy not in self.STRATEGIES:
            raise ValueError(
                f"unknown rerank strategy: {strategy!r}; "
                f"expected one of {self.STRATEGIES}"
            )
        self.strategy = strategy

        # dashscope params
        self._ds_api_key = dashscope_api_key
        self._ds_model = dashscope_model
        self._ds_base_url = dashscope_base_url.rstrip("/")
        self._ds_timeout = dashscope_timeout
        # hybrid params
        self._hy_alpha = hybrid_alpha
        self._hy_beta = hybrid_beta
        self._hy_gamma = hybrid_gamma
        # mmr params
        self._mmr_lambda = mmr_lambda
        # llm params
        self._llm_model = llm_model
        self._llm_max = llm_max_candidates

        # dispatch table: strategy name -> algorithm method
        self._dispatch = {
            "null": self._rerank_null,
            "dashscope": self._rerank_dashscope,
            "hybrid": self._rerank_hybrid,
            "mmr": self._rerank_mmr,
            "llm": self._rerank_llm,
        }

    # ── construction ───────────────────────────────────────────────

    @classmethod
    def from_settings(cls) -> "Reranker":
        """Build from ``settings.rerank.*``.

        When ``rerank_enabled`` is False, forces the ``null`` strategy
        regardless of ``rerank_provider`` (matches legacy semantics).
        """
        strategy = "null" if not settings.rerank_enabled else settings.rerank_provider
        return cls(
            strategy=strategy,
            dashscope_api_key=settings.rerank_api_key,
            dashscope_model=settings.rerank_model,
            dashscope_base_url=settings.rerank_base_url,
            dashscope_timeout=settings.rerank_timeout,
            hybrid_alpha=getattr(settings, "rerank_alpha", 0.7),
            hybrid_beta=getattr(settings, "rerank_beta", 0.2),
            hybrid_gamma=getattr(settings, "rerank_gamma", 0.1),
            mmr_lambda=getattr(settings, "rerank_lambda", 0.7),
            llm_model=settings.llm_model,
        )

    # ── dispatch entry point ────────────────────────────────────────

    def rerank(
        self,
        query: str,
        docs: Sequence[Document],
        top_k: int,
        strategy: Optional[str] = None,
    ) -> list[Document]:
        """Rerank ``docs`` for ``query`` using the active (or override) strategy.

        Never raises: on any internal failure, falls back to
        ``list(docs)[:top_k]``.
        """
        name = (strategy or self.strategy).lower()
        if name == "none":
            name = "null"
        fn = self._dispatch.get(name)
        if fn is None:
            logger.warning(
                "{} unknown strategy {!r} -> null", _LOG_PREFIX, name
            )
            fn = self._rerank_null
            name = "null"
        try:
            return fn(query, docs, top_k)
        except Exception as exc:
            logger.warning(
                "{} {} failed ({}) -> fallback to embedding order",
                _LOG_PREFIX,
                name,
                type(exc).__name__,
            )
            return list(docs)[:top_k]

    # ── algorithms ─────────────────────────────────────────────────

    def _rerank_null(
        self, query: str, docs: Sequence[Document], top_k: int
    ) -> list[Document]:
        """Passthrough - preserves the embedding order."""
        return list(docs)[:top_k]

    def _rerank_dashscope(
        self, query: str, docs: Sequence[Document], top_k: int
    ) -> list[Document]:
        """Cross-encoder rerank via DashScope gte-rerank-v2 REST API.

        POST {base_url}/services/rerank/text-rerank/text-rerank
            request:  {"model": "...", "input": {"query": "...", "documents": [...]}}
            response: {"output": {"results": [{"index": int, "relevance_score": float}]}}
        ``index`` references the request ``documents`` position, not a
        stable doc id - we map back into ``docs`` by that index.
        """
        docs_list = list(docs)
        if not docs_list:
            return []
        if not query or not query.strip():
            return docs_list[:top_k]
        if not self._ds_api_key:
            logger.warning(
                "{} dashscope api_key missing -> fallback", _LOG_PREFIX
            )
            return docs_list[:top_k]

        documents = [self._truncate(d.page_content or "") for d in docs_list]
        url = f"{self._ds_base_url}/services/rerank/text-rerank/text-rerank"
        payload = {
            "model": self._ds_model,
            "input": {"query": query, "documents": documents},
            "parameters": {"top_n": top_k, "return_documents": False},
        }
        headers = {
            "Authorization": f"Bearer {self._ds_api_key}",
            "Content-Type": "application/json",
        }

        try:
            with httpx.Client(timeout=self._ds_timeout) as client:
                resp = client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data: dict = resp.json()
        except httpx.HTTPStatusError as exc:
            logger.warning(
                "{} dashscope HTTP {} -> fallback. body={}",
                _LOG_PREFIX,
                exc.response.status_code,
                exc.response.text[:200],
            )
            return docs_list[:top_k]
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning(
                "{} dashscope call failed ({}) -> fallback",
                _LOG_PREFIX,
                type(exc).__name__,
            )
            return docs_list[:top_k]

        results = (data.get("output") or {}).get("results") or []
        if not isinstance(results, list) or not results:
            logger.warning(
                "{} dashscope empty results -> fallback", _LOG_PREFIX
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
            # Immutable: copy metadata, never mutate the input doc.
            new_meta = dict(doc.metadata or {})
            if isinstance(score, (int, float)):
                new_meta["rerank_score"] = float(score)
            ordered.append(
                Document(page_content=doc.page_content, metadata=new_meta)
            )
            if len(ordered) >= top_k:
                break

        if not ordered:
            return docs_list[:top_k]

        logger.info(
            "{} dashscope reranked: in={} out={} top_score={}",
            _LOG_PREFIX,
            len(docs_list),
            len(ordered),
            ordered[0].metadata.get("rerank_score"),
        )
        return ordered

    @staticmethod
    def _truncate(text: str, limit: int = 1500) -> str:
        # gte-rerank-v2 context ~512 tokens; hard cut keeps the call fast.
        if len(text) <= limit:
            return text
        return text[:limit]

    def _rerank_hybrid(
        self, query: str, docs: Sequence[Document], top_k: int
    ) -> list[Document]:
        """Pointwise weighted blend - no external API, deterministic.

            final = alpha * embedding_sim + beta * recency + gamma * field_boost
        """
        docs_list = list(docs)
        if not docs_list:
            return []

        q_tokens = _tokenize(query)
        scored: list[tuple[float, Document]] = []
        for d in docs_list:
            emb = float(d.metadata.get("score", 0.0))
            recency = self._recency(d)
            boost = self._field_boost(d, q_tokens)
            final = (
                self._hy_alpha * emb
                + self._hy_beta * recency
                + self._hy_gamma * boost
            )
            scored.append((final, d))

        scored.sort(key=lambda x: x[0], reverse=True)
        # Immutable: attach final_score on metadata copies, never on inputs.
        return [
            Document(
                page_content=d.page_content,
                metadata={**d.metadata, "final_score": s},
            )
            for s, d in scored[:top_k]
        ]

    @staticmethod
    def _recency(doc: Document) -> float:
        # No timestamp field in the current Milvus schema; neutral weight.
        # Wire to partition / upload time once a temporal field is stored.
        return 0.0

    @staticmethod
    def _field_boost(doc: Document, q_tokens: set[str]) -> float:
        if not q_tokens:
            return 0.0
        meta = doc.metadata or {}
        title_tokens = _tokenize(meta.get("title", "")) | _tokenize(
            meta.get("section_title", "")
        )
        if not title_tokens:
            return 0.0
        return len(q_tokens & title_tokens) / len(q_tokens)

    def _rerank_mmr(
        self, query: str, docs: Sequence[Document], top_k: int
    ) -> list[Document]:
        """Maximal Marginal Relevance - balance relevance vs diversity.

            pick argmax_d  lambda * relevance(d) - (1 - lambda) * max sim(d, picked)
        """
        docs_list = list(docs)
        if len(docs_list) <= top_k:
            return list(docs_list)

        relevance = [float(d.metadata.get("score", 0.0)) for d in docs_list]
        token_sets = [_tokenize(d.page_content) for d in docs_list]

        def _sim(i: int, j: int) -> float:
            return _jaccard(token_sets[i], token_sets[j])

        picked = [0]
        remaining = set(range(1, len(docs_list)))
        while len(picked) < top_k and remaining:
            best_idx, best_score = None, -float("inf")
            for i in remaining:
                max_sim = max(_sim(i, j) for j in picked)
                score = (
                    self._mmr_lambda * relevance[i]
                    - (1 - self._mmr_lambda) * max_sim
                )
                if score > best_score:
                    best_idx, best_score = i, score
            if best_idx is None:
                break
            picked.append(best_idx)
            remaining.discard(best_idx)

        return [docs_list[i] for i in picked]

    def _rerank_llm(
        self, query: str, docs: Sequence[Document], top_k: int
    ) -> list[Document]:
        """LLM-as-reranker (pointwise). Placeholder - passthrough until built."""
        logger.warning(
            "{} llm strategy not implemented -> passthrough", _LOG_PREFIX
        )
        return list(docs)[:top_k]


# ── module-level singleton accessor ─────────────────────────────────


_singleton: Optional[Reranker] = None


def get_reranker() -> Reranker:
    """Return the process-wide Reranker configured from settings.

    The strategy is chosen dynamically from ``settings.rerank_provider``
    (subject to ``rerank_enabled``). Cached; restart to switch.
    """
    global _singleton
    if _singleton is None:
        _singleton = Reranker.from_settings()
    return _singleton


def list_strategies() -> list[str]:
    """Return the names of available rerank strategies."""
    return list(Reranker.STRATEGIES)


__all__ = ["Reranker", "get_reranker", "list_strategies"]
