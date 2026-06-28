"""Quiz generation quality metrics.

Computes post-generation quality signals that are persisted on QuizSet
for monitoring and regression tracking. Pure functions — no I/O.
"""

from __future__ import annotations

from typing import Any

from app.agent.quiz.graph import _is_traced_to_source


def compute_traceability_rate(questions: list[dict], chunks: list[dict]) -> float:
    """Fraction of questions whose answer terms trace back to their source chunk.

    A question is traceable if _is_traced_to_source returns True for its
    answer terms against the chunk at source_chunk_index. Returns 0.0 when
    the question list is empty.
    """
    if not questions:
        return 0.0

    traced = 0
    for q in questions:
        chunk_idx = q.get("source_chunk_index", 0)
        if not isinstance(chunk_idx, int) or not 0 <= chunk_idx < len(chunks):
            continue
        source = chunks[chunk_idx].get("content", "")

        qtype = q.get("type") or q.get("question_type", "")
        if qtype in ("single_choice", "multi_choice"):
            terms = []
            correct = q.get("correct_answer")
            answers = correct if isinstance(correct, list) else [correct]
            for a in answers:
                terms.append(str(a))
        elif qtype == "short_answer":
            terms = [str(k) for k in q.get("keywords", [])]
        elif qtype == "essay":
            terms = [str(q.get("model_answer", ""))]
        else:
            continue

        terms = [t for t in terms if len(t) > 1]
        if _is_traced_to_source(terms, source):
            traced += 1

    return round(traced / len(questions), 3)


def compute_dedup_rate(questions: list[dict]) -> float:
    """Fraction of unique question texts. 1.0 = no duplicates."""
    if not questions:
        return 1.0
    texts = [(q.get("question") or q.get("question_text", "")).strip() for q in questions]
    unique = len(set(texts))
    return round(unique / len(texts), 3)


def compute_type_distribution_match(
    questions: list[dict], requested: dict[str, int]
) -> bool:
    """True if actual type counts match the requested distribution."""
    if not requested:
        return True
    actual: dict[str, int] = {}
    for q in questions:
        qtype = q.get("type") or q.get("question_type", "")
        actual[qtype] = actual.get(qtype, 0) + 1
    return all(actual.get(k, 0) == v for k, v in requested.items())


def compute_quiz_quality(
    questions: list[dict[str, Any]],
    chunks: list[dict[str, Any]],
    requested_distribution: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Aggregate quality metrics for a generated quiz set."""
    return {
        "traceability_rate": compute_traceability_rate(questions, chunks),
        "dedup_rate": compute_dedup_rate(questions),
        "type_distribution_match": compute_type_distribution_match(
            questions, requested_distribution or {}
        ),
        "question_count": len(questions),
    }
