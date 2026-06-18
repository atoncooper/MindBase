"""Pure-function metric calculators for RAG evaluation.

Every function here is deterministic and side-effect-free so they can
be unit-tested in isolation. No I/O, no LLM calls — those live in
``judge.py``.
"""

from __future__ import annotations

import math
import re
import statistics
from collections import defaultdict
from typing import Iterable, Sequence

from .schema import SampleResult, SummaryMetrics

_BVID_RE = re.compile(r"BV[A-Za-z0-9]{10}")


def recall_at_k(
    retrieved_bvids: Sequence[str],
    must_contain_bvid: Sequence[str],
    k: int = 5,
) -> float:
    """Binary 0/1: did top-K retrieved bvids include AT LEAST ONE expected bvid?

    Returns 1.0 when ``must_contain_bvid`` is empty (vacuously satisfied) so that
    samples without explicit retrieval expectations don't drag the metric down.
    """

    if not must_contain_bvid:
        return 1.0
    top_k = list(retrieved_bvids)[:k]
    return 1.0 if any(b in top_k for b in must_contain_bvid) else 0.0


def mrr_at_k(
    retrieved_bvids: Sequence[str],
    must_contain_bvid: Sequence[str],
    k: int = 5,
) -> float:
    """Mean Reciprocal Rank at K — 1/rank of the first hit, else 0.

    Differentiates "hit at rank 1" (1.0) from "hit at rank 5" (0.2),
    which a binary recall@K cannot distinguish. Critical for measuring
    rerank quality: a rerank that promotes the correct chunk from rank
    4 to rank 1 leaves recall@5 unchanged but lifts MRR from 0.25 → 1.0.

    Returns 1.0 when ``must_contain_bvid`` is empty (vacuously satisfied),
    matching ``recall_at_k``'s convention.
    """

    if not must_contain_bvid:
        return 1.0
    expected = set(must_contain_bvid)
    for idx, bvid in enumerate(list(retrieved_bvids)[:k], 1):
        if bvid in expected:
            return 1.0 / idx
    return 0.0


def precision_at_k(judge_relevance: Sequence[int], k: int = 5) -> float:
    """Mean of relevance labels (each 0 or 1) over the top-K results.

    Returns 1.0 when there were no retrievals — no false positives, so
    precision is undefined; we map "undefined" -> 1.0 to avoid penalizing
    legitimate empty-knowledge-base cases.
    """

    top_k = [int(bool(x)) for x in list(judge_relevance)[:k]]
    if not top_k:
        return 1.0
    return sum(top_k) / len(top_k)


def citation_accuracy(answer_text: str, retrieved_bvids: Sequence[str]) -> float:
    """Fraction of bvids cited in the answer that were actually retrieved.

    Hallucinated citations (bvids cited but never retrieved) lower the score.
    No citations -> 1.0 (we don't penalize answers that don't cite).
    """

    cited = _BVID_RE.findall(answer_text or "")
    if not cited:
        return 1.0
    retrieved_set = set(retrieved_bvids)
    valid = sum(1 for c in cited if c in retrieved_set)
    return valid / len(cited)


def keyword_hit_rate(answer_text: str, must_contain_keywords: Sequence[str]) -> float:
    """Fraction of expected keywords that appear in the answer (case-insensitive).

    Cheap proxy for content coverage; complements the LLM-judge score.
    """

    if not must_contain_keywords:
        return 1.0
    haystack = (answer_text or "").lower()
    hits = sum(1 for kw in must_contain_keywords if kw.lower() in haystack)
    return hits / len(must_contain_keywords)


def negative_keyword_penalty(
    answer_text: str, negative_keywords: Sequence[str]
) -> int:
    """How many forbidden keywords appear in the answer."""

    if not negative_keywords:
        return 0
    haystack = (answer_text or "").lower()
    return sum(1 for kw in negative_keywords if kw.lower() in haystack)


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def _percentile(values: Sequence[float], pct: float) -> float:
    """Linear-interpolated percentile (matches numpy default)."""

    if not values:
        return 0.0
    sorted_vals = sorted(values)
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    rank = (pct / 100.0) * (len(sorted_vals) - 1)
    lo = math.floor(rank)
    hi = math.ceil(rank)
    if lo == hi:
        return float(sorted_vals[int(rank)])
    weight = rank - lo
    return float(sorted_vals[lo] * (1 - weight) + sorted_vals[hi] * weight)


def _mean(values: Iterable[float]) -> float:
    """Mean of the iterable, 0.0 on empty input."""

    items = list(values)
    return statistics.fmean(items) if items else 0.0


def aggregate(results: Sequence[SampleResult]) -> SummaryMetrics:
    """Roll a list of SampleResult into a SummaryMetrics block."""

    if not results:
        return SummaryMetrics(
            samples=0,
            recall_at_5=0.0,
            precision_at_5=0.0,
            mrr_at_5=0.0,
            answer_quality_avg=0.0,
            citation_accuracy=0.0,
            keyword_hit_rate=0.0,
            latency_p50_ms=0,
            latency_p95_ms=0,
            latency_p99_ms=0,
            by_category={},
        )

    latencies = [r.latency_ms for r in results]
    by_category: dict[str, dict[str, float]] = {}
    grouped: dict[str, list[SampleResult]] = defaultdict(list)
    for r in results:
        grouped[r.category].append(r)
    for cat, items in grouped.items():
        by_category[cat] = {
            "n": len(items),
            "recall_at_5": _mean(r.recall_at_5 for r in items),
            "precision_at_5": _mean(r.precision_at_5 for r in items),
            "mrr_at_5": _mean(r.mrr_at_5 for r in items),
            "answer_quality_avg": _mean(r.answer_quality for r in items),
            "citation_accuracy": _mean(r.citation_accuracy for r in items),
            "keyword_hit_rate": _mean(r.keyword_hit_rate for r in items),
        }

    return SummaryMetrics(
        samples=len(results),
        recall_at_5=_mean(r.recall_at_5 for r in results),
        precision_at_5=_mean(r.precision_at_5 for r in results),
        mrr_at_5=_mean(r.mrr_at_5 for r in results),
        answer_quality_avg=_mean(r.answer_quality for r in results),
        citation_accuracy=_mean(r.citation_accuracy for r in results),
        keyword_hit_rate=_mean(r.keyword_hit_rate for r in results),
        latency_p50_ms=int(_percentile(latencies, 50)),
        latency_p95_ms=int(_percentile(latencies, 95)),
        latency_p99_ms=int(_percentile(latencies, 99)),
        by_category=by_category,
    )
