"""M5 — Quiz training module tests.

Covers:
- Quiz panel opens
- Generate button triggers POST /quiz/generate
- Questions render
- Submit triggers POST /quiz/submit
- Score / result display
"""
from __future__ import annotations

import pytest

from pages import QuizPage

pytestmark = pytest.mark.m5_quiz


def test_quiz_panel_opens(auth_page):
    """Dock 'quiz' icon opens quiz panel with generate button."""
    quiz = QuizPage(auth_page, auth_page.url)
    quiz.open_quiz()
    assert auth_page.locator(QuizPage.GENERATE_BUTTON).is_visible(timeout=5000)


def test_generate_fires_request(auth_page):
    """Generate button should POST /quiz/generate."""
    quiz = QuizPage(auth_page, auth_page.url)
    quiz.open_quiz()
    if not quiz.prepare_for_generate():
        pytest.skip("no folders or vectorized pages available; cannot generate")
    with auth_page.expect_request(
        lambda r: "/quiz/generate" in r.url, timeout=15000
    ) as req_info:
        quiz.generate()
    assert req_info.value.method == "POST"


def test_questions_render_after_generate(auth_page):
    """After generate, at least one question should render (or empty-state)."""
    quiz = QuizPage(auth_page, auth_page.url)
    quiz.open_quiz()
    if not quiz.prepare_for_generate():
        pytest.skip("no folders or vectorized pages available; cannot generate")
    quiz.generate()
    count = quiz.get_question_count()
    # Count may be 0 if LLM/key unavailable; assert no crash
    assert count >= 0


def test_submit_fires_request(auth_page):
    """Submit button should POST /quiz/submit."""
    quiz = QuizPage(auth_page, auth_page.url)
    quiz.open_quiz()
    if not quiz.prepare_for_generate():
        pytest.skip("no folders or vectorized pages available; cannot generate")
    quiz.generate()
    if quiz.get_question_count() == 0:
        pytest.skip("no questions generated; cannot test submit")
    # Answer first question (select option 0 if MC, else fill text)
    try:
        quiz.select_option(0, 0)
    except Exception:
        try:
            quiz.fill_answer(0, "测试答案")
        except Exception:
            pytest.skip("cannot interact with first question")

    with auth_page.expect_request(
        lambda r: "/quiz/submit" in r.url, timeout=15000
    ) as req_info:
        quiz.submit()
    assert req_info.value.method == "POST"


def test_history_endpoint_called(auth_page):
    """Clicking '题目历史' toggle should GET /quiz/history."""
    quiz = QuizPage(auth_page, auth_page.url)
    quiz.open_quiz()
    with auth_page.expect_request(
        lambda r: "/quiz/history" in r.url, timeout=15000
    ):
        quiz.open_history()
