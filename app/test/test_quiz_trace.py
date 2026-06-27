"""Tests for quiz answer-trace validation.

Covers:
- `_is_traced_to_source`: substring + 2-gram dual-path anchor check
- `validate_question`: trace failure downgrades to `_low_confidence` flag
  (no longer a hard reject)

These tests pin the fix for the regression where qwen3-max rephrased
answers were 100% rejected by the old 2-gram floor=1 rule.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.agent.quiz.graph import (  # noqa: E402
    _is_traced_to_source,
    normalize_question,
    validate_question,
)

SOURCE = (
    "大语言模型通过向量检索实现语义召回，"
    "RAG 系统将检索到的片段作为上下文输入 LLM 生成答案。"
    "DashScope 提供 text-embedding 接口，维度 1024。"
)

CHUNKS = [{"content": SOURCE, "bvid": "BV_test", "title": "test"}]


# ─── _is_traced_to_source ────────────────────────────────────────


class TestIsTracedToSource:
    """Verify each term must independently anchor to source."""

    def test_verbatim_extract_passes(self) -> None:
        assert _is_traced_to_source(["向量检索实现语义召回"], SOURCE) is True

    def test_rephrased_with_substring_passes(self) -> None:
        # qwen3-max style: rephrased but embeds an original ≥3-char substring
        assert _is_traced_to_source(["通过向量检索来做语义召回"], SOURCE) is True
        assert _is_traced_to_source(["RAG 系统的核心是检索"], SOURCE) is True

    def test_pure_fabrication_fails(self) -> None:
        assert _is_traced_to_source(["量子纠缠效应导致坍缩"], SOURCE) is False

    def test_english_token_overlap_passes(self) -> None:
        assert _is_traced_to_source(["DashScope"], SOURCE) is True
        assert _is_traced_to_source(["embedding"], SOURCE) is True

    def test_short_term_no_anchor_fails(self) -> None:
        assert _is_traced_to_source(["量子"], SOURCE) is False

    def test_multi_choice_all_must_trace(self) -> None:
        assert _is_traced_to_source(["向量检索", "RAG 系统", "DashScope"], SOURCE) is True

    def test_multi_choice_one_fabrication_fails(self) -> None:
        assert _is_traced_to_source(["向量检索", "量子纠缠", "DashScope"], SOURCE) is False

    def test_empty_terms_fails(self) -> None:
        assert _is_traced_to_source([], SOURCE) is False

    def test_all_terms_skipped_fails(self) -> None:
        # All terms <2 chars are skipped → validated=0 → must fail
        # (guards the bug where empty validation passed as True)
        assert _is_traced_to_source(["a"], SOURCE) is False

    def test_term_shorter_than_3_uses_2gram_fallback(self) -> None:
        # 2-char term: substring path skipped (len<3), 2-gram path applies
        # "检索" → 2-gram {检索} ∩ source_tokens → hit
        assert _is_traced_to_source(["检索"], SOURCE) is True
        # "量子" → 2-gram {量子} ∩ source_tokens → miss
        assert _is_traced_to_source(["量子"], SOURCE) is False

    def test_case_insensitive_substring(self) -> None:
        assert _is_traced_to_source(["RAG 系统"], SOURCE) is True  # source has "RAG"
        assert _is_traced_to_source(["rag 系统"], SOURCE) is True  # lowercased match


# ─── validate_question (trace downgrade) ─────────────────────────


def _make_single_choice(
    question: str,
    correct: str,
    options: list[str],
    chunk_idx: int = 0,
) -> dict:
    return {
        "type": "single_choice",
        "question": question,
        "options": options,
        "correct_answer": correct,
        "source_chunk_index": chunk_idx,
        "explanation": "test",
        "difficulty": "medium",
    }


def _make_multi_choice(
    question: str,
    correct: list[str],
    options: list[str],
    chunk_idx: int = 0,
) -> dict:
    return {
        "type": "multi_choice",
        "question": question,
        "options": options,
        "correct_answer": correct,
        "source_chunk_index": chunk_idx,
        "explanation": "test",
        "difficulty": "medium",
    }


class TestValidateQuestionTraceDowngrade:
    """Trace failure no longer hard-rejects; it flags _low_confidence."""

    def test_verbatim_answer_passes_without_flag(self) -> None:
        q = _make_single_choice(
            "RAG 系统用什么生成答案？",
            "A",
            ["LLM", "数据库", "缓存", "队列"],
        )
        assert validate_question(q, CHUNKS) is True
        assert q.get("_low_confidence") is not True

    def test_fabricated_answer_passes_with_low_confidence_flag(self) -> None:
        # Old behavior: rejected (False). New behavior: accepted + flagged.
        q = _make_single_choice(
            "导致坍缩的核心机制是什么？",
            "A",
            ["量子纠缠效应", "向量检索", "语义召回", "上下文输入"],
        )
        assert validate_question(q, CHUNKS) is True
        assert q.get("_low_confidence") is True

    def test_rephrased_answer_passes_without_flag(self) -> None:
        # Answer embeds original substring → traced → no flag
        q = _make_single_choice(
            "RAG 系统的核心是什么？",
            "A",
            ["向量检索", "量子纠缠", "缓存命中", "队列调度"],
        )
        assert validate_question(q, CHUNKS) is True
        assert q.get("_low_confidence") is not True

    def test_multi_choice_partial_fabrication_flagged(self) -> None:
        # One correct option fabricated, others trace → multi_choice requires
        # all to trace independently; failure → downgrade flag
        q = _make_multi_choice(
            "以下哪些与 RAG 系统相关？（多选）",
            ["A", "B"],
            ["向量检索", "量子坍缩", "语义召回", "缓存命中"],
        )
        assert validate_question(q, CHUNKS) is True
        assert q.get("_low_confidence") is True

    def test_low_confidence_flag_propagates_through_normalize(self) -> None:
        q = _make_single_choice(
            "导致坍缩的核心机制是什么？",
            "A",
            ["量子纠缠效应", "向量检索", "语义召回", "上下文输入"],
        )
        validate_question(q, CHUNKS)
        assert q.get("_low_confidence") is True

        normalized = normalize_question(q, CHUNKS)
        assert normalized.get("_low_confidence") is True
        # normalize must preserve other injected fields
        assert "question_uuid" in normalized
        assert "bvid" in normalized


# ─── validate_question (structural hard rejects still enforced) ──


class TestValidateQuestionStructuralRejects:
    """Structural errors are still hard rejects (return False)."""

    def test_missing_question_rejected(self) -> None:
        q = _make_single_choice("", "A", ["a", "b", "c", "d"])
        assert validate_question(q, CHUNKS) is False
        assert q.get("_low_confidence") is not True  # not flagged, just rejected

    def test_too_few_options_rejected(self) -> None:
        q = _make_single_choice("题目", "A", ["a", "b"])  # <4 options
        assert validate_question(q, CHUNKS) is False

    def test_chunk_index_out_of_range_rejected(self) -> None:
        q = _make_single_choice("题目", "A", ["a", "b", "c", "d"], chunk_idx=99)
        assert validate_question(q, CHUNKS) is False

    def test_unsupported_type_rejected(self) -> None:
        q: dict = {
            "type": "fill_blank",
            "question": "题目",
            "source_chunk_index": 0,
        }
        assert validate_question(q, CHUNKS) is False

    def test_multi_choice_wrong_answer_count_rejected(self) -> None:
        # multi_choice requires 2-4 correct answers
        q = _make_multi_choice(
            "题目（多选）",
            ["A"],  # only 1 — invalid
            ["a", "b", "c", "d"],
        )
        assert validate_question(q, CHUNKS) is False


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
