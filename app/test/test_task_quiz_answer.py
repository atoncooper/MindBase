"""Tests for 定时出题答题判题（业务逻辑在主 app）。

覆盖 judge_task_quiz_answer 的字母/全文容错 + 填空/简答 + 路由鉴权。
"""

import pytest
from fastapi import HTTPException

from app.routers.task_answer import TaskAnswerRequest, submit_answer
from app.services.task_quiz_answer import judge_task_quiz_answer


class FakeRequest:
    """Minimal stand-in for starlette.Request (only .headers used)."""

    def __init__(self, headers=None):
        self.headers = headers or {}


CHOICE_OPTIONS = ["A. 发散", "B. 收敛", "C. 振荡", "D. 不确定"]


# ── choice：字母/全文容错 ──────────────────────────────────────────

def test_choice_letter_answer_matches_full_text():
    quiz = {"question_type": "choice", "answer": "B", "options": CHOICE_OPTIONS}
    assert judge_task_quiz_answer(quiz, "B. 收敛") is True


def test_choice_letter_answer_matches_bare_text():
    quiz = {"question_type": "choice", "answer": "B", "options": CHOICE_OPTIONS}
    assert judge_task_quiz_answer(quiz, "收敛") is True


def test_choice_letter_answer_matches_letter():
    quiz = {"question_type": "choice", "answer": "B", "options": CHOICE_OPTIONS}
    assert judge_task_quiz_answer(quiz, "B") is True


def test_choice_full_text_answer_matches_full_text():
    quiz = {"question_type": "choice", "answer": "B. 收敛", "options": CHOICE_OPTIONS}
    assert judge_task_quiz_answer(quiz, "B. 收敛") is True


def test_choice_wrong_option():
    quiz = {"question_type": "choice", "answer": "B", "options": CHOICE_OPTIONS}
    assert judge_task_quiz_answer(quiz, "A. 发散") is False


def test_choice_wrong_bare_text():
    quiz = {"question_type": "choice", "answer": "B", "options": CHOICE_OPTIONS}
    assert judge_task_quiz_answer(quiz, "发散") is False


def test_choice_lowercase_letter_still_case_sensitive():
    quiz = {"question_type": "choice", "answer": "B", "options": CHOICE_OPTIONS}
    assert judge_task_quiz_answer(quiz, "b") is False


def test_choice_no_options_falls_back_exact():
    # 无 options（历史数据）回退精确比较
    assert judge_task_quiz_answer({"question_type": "choice", "answer": "A"}, "A") is True
    assert judge_task_quiz_answer({"question_type": "choice", "answer": "A"}, "B") is False


# ── fill_blank / short_answer ─────────────────────────────────────

def test_fill_blank_exact_trimmed():
    assert judge_task_quiz_answer({"question_type": "fill_blank", "answer": "42"}, " 42 ") is True
    assert judge_task_quiz_answer({"question_type": "fill_blank", "answer": "42"}, "43") is False


def test_short_answer_contains_case_insensitive():
    quiz = {"question_type": "short_answer", "answer": "Newton"}
    assert judge_task_quiz_answer(quiz, "isaac newton was here") is True
    assert judge_task_quiz_answer({"question_type": "short_answer", "answer": "牛顿"}, "爱因斯坦") is False


# ── edge cases ────────────────────────────────────────────────────

def test_empty_correct_answer_false():
    assert judge_task_quiz_answer({"question_type": "choice", "answer": ""}, "A") is False


def test_nil_quiz_false():
    assert judge_task_quiz_answer(None, "A") is False


# ── 路由鉴权 ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_submit_answer_401_without_x_uid():
    with pytest.raises(HTTPException) as exc:
        await submit_answer(
            FakeRequest(),
            "some-task",
            TaskAnswerRequest(answer="A"),
        )
    assert exc.value.status_code == 401
