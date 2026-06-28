"""Baseline tests for QuizGraderService pure grading functions.

Covers _grade_single_choice / _grade_multi_choice / _grade_short_answer
partial-credit and keyword-matching behavior. These are the grading paths
not already covered by test_quiz_structured_output.py.
"""

from app.services.quiz_grader import QuizGraderService


def _service() -> QuizGraderService:
    return QuizGraderService()


# ── single_choice ────────────────────────────────────────────────


def test_single_choice_correct_answer_scores_10() -> None:
    result = _service()._grade_single_choice("A", "A")
    assert result == {"is_correct": True, "auto_score": 10}


def test_single_choice_wrong_answer_scores_0() -> None:
    result = _service()._grade_single_choice("B", "A")
    assert result == {"is_correct": False, "auto_score": 0}


def test_single_choice_is_case_insensitive_and_strips_whitespace() -> None:
    result = _service()._grade_single_choice("  a ", "A")
    assert result["is_correct"] is True
    assert result["auto_score"] == 10


# ── multi_choice partial credit ──────────────────────────────────


def test_multi_choice_full_correct_scores_10() -> None:
    result = _service()._grade_multi_choice(["A", "C"], ["A", "C"])
    assert result["is_correct"] is True
    assert result["auto_score"] == 10


def test_multi_choice_partial_credit_when_subset_correct() -> None:
    # correct={A,C}, user picks only A → 1 correct, 0 wrong
    # points_per = 10/2 = 5; score = 1*5 - 0*5 = 5 (symmetric deduction)
    result = _service()._grade_multi_choice(["A"], ["A", "C"])
    assert result["is_correct"] is False
    assert result["auto_score"] == 5
    assert result["grading_detail"]["correct_picks"] == 1
    assert result["grading_detail"]["wrong_picks"] == 0


def test_multi_choice_wrong_pick_reduces_score() -> None:
    # correct={A,C}, user picks A,B → 1 correct, 1 wrong
    # score = 1*5 - 1*5 = 0 (symmetric: wrong pick cancels correct pick)
    result = _service()._grade_multi_choice(["A", "B"], ["A", "C"])
    assert result["is_correct"] is False
    assert result["auto_score"] == 0


def test_multi_choice_all_wrong_scores_0() -> None:
    # correct={A,C}, user picks B,D → 0 correct, 2 wrong
    # score = max(0, 0 - 2*5) = 0
    result = _service()._grade_multi_choice(["B", "D"], ["A", "C"])
    assert result["is_correct"] is False
    assert result["auto_score"] == 0


def test_multi_choice_extra_pick_beyond_correct_is_wrong() -> None:
    # correct={A,C}, user picks A,B,C → 2 correct, 1 wrong
    # score = 2*5 - 1*5 = 5
    result = _service()._grade_multi_choice(["A", "B", "C"], ["A", "C"])
    assert result["is_correct"] is False
    assert result["auto_score"] == 5


# ── short_answer keyword matching ────────────────────────────────


def test_short_answer_all_keywords_matched_scores_full() -> None:
    result = _service()._grade_short_answer(
        "向量检索通过相似度搜索找到语义相关内容",
        "参考答案",
        ["相似度", "语义", "相关内容"],
    )
    assert result["is_correct"] is True
    # score = round(1.0 * 10) = 10 (aligned with choice scoring)
    assert result["auto_score"] == 10
    assert result["matched_keywords"] == ["相似度", "语义", "相关内容"]


def test_short_answer_no_keyword_match_scores_0() -> None:
    result = _service()._grade_short_answer(
        "完全无关的答案",
        "参考答案",
        ["相似度", "语义", "相关内容"],
    )
    assert result["is_correct"] is False
    assert result["auto_score"] == 0
    assert result["matched_keywords"] == []


def test_short_answer_partial_match_below_threshold_is_incorrect() -> None:
    # 3 keywords, match 1 → rate=0.333, below 0.8 threshold → incorrect
    # score = round(0.333 * 10) = 3
    result = _service()._grade_short_answer(
        "只提到相似度",
        "参考答案",
        ["相似度", "语义", "相关内容"],
    )
    assert result["is_correct"] is False
    assert result["auto_score"] == 3


def test_short_answer_half_match_is_incorrect_under_strict_threshold() -> None:
    # 4 keywords, match 2 → rate=0.5, below 0.8 threshold → incorrect
    result = _service()._grade_short_answer(
        "相似度和语义都被提到",
        "参考答案",
        ["相似度", "语义", "相关内容", "原文"],
    )
    assert result["is_correct"] is False
    assert result["auto_score"] == 5


def test_short_answer_80pct_match_is_correct() -> None:
    # 5 keywords, match 4 → rate=0.8, meets >= 0.8 threshold → correct
    result = _service()._grade_short_answer(
        "相似度语义相关内容原文都提到了",
        "参考答案",
        ["相似度", "语义", "相关内容", "原文", "未提及词"],
    )
    assert result["is_correct"] is True
    assert result["auto_score"] == 8


def test_short_answer_keyword_matching_is_case_insensitive() -> None:
    result = _service()._grade_short_answer(
        "SIMILARITY is key",
        "参考答案",
        ["similarity"],
    )
    assert result["is_correct"] is True
    assert result["matched_keywords"] == ["similarity"]


def test_short_answer_empty_keywords_returns_zero_score() -> None:
    # defensive: no keywords → match_rate=0 (guarded by `if keywords else 0`)
    result = _service()._grade_short_answer("任何答案", "参考答案", [])
    assert result["is_correct"] is False
    assert result["auto_score"] == 0
