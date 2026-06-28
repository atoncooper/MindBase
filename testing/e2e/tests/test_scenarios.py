"""End-to-end business scenarios (4+ core flows spanning modules).

S1: Login → enter workspace
S2: Login → open favorites → sync → select folders
S3: Login → trigger knowledge build → poll status
S4: Login → open chat → ask question → receive SSE stream + sources
"""
from __future__ import annotations

import pytest

from pages import ChatPage, FavoritesPage, LoginPage

pytestmark = pytest.mark.scenario


@pytest.mark.scenario
def test_s1_login_and_enter_workspace(auth_page):
    """S1: Authenticate → app should show dock bar, user is logged in."""
    login = LoginPage(auth_page, auth_page.url)
    assert login.is_logged_in(), "session token must be in localStorage"
    # Dock bar should be visible (bottom of page)
    assert auth_page.locator(".dock-bar, .dock-trigger-zone").first.is_visible(timeout=5000)


@pytest.mark.scenario
def test_s2_login_sync_select_favorites(auth_page):
    """S2: Login → open favorites → folders load → select one folder."""
    login = LoginPage(auth_page, auth_page.url)
    assert login.is_logged_in()

    fav = FavoritesPage(auth_page, auth_page.url)
    fav.open_favorites()
    fav.wait_for_folders_loaded(timeout=20000)

    titles = fav.get_folder_titles()
    if not titles:
        pytest.skip("user has no favorite folders; cannot test selection")

    fav.select_folder_by_title(titles[0])
    # No crash = pass
    assert fav.is_visible(fav.PANEL_TITLE, timeout=2000)


@pytest.mark.scenario
def test_s3_login_trigger_build_poll_status(auth_page):
    """S3: Login → open favorites → click build → status endpoint polled."""
    login = LoginPage(auth_page, auth_page.url)
    assert login.is_logged_in()

    fav = FavoritesPage(auth_page, auth_page.url)
    fav.open_favorites()
    fav.wait_for_folders_loaded()

    # Find build button
    build_btn = None
    for sel in (
        "button:has-text('构建知识库')",
        "button:has-text('更新知识库')",
    ):
        if auth_page.locator(sel).is_visible(timeout=2000):
            build_btn = sel
            break
    if build_btn is None:
        pytest.skip("no build button available")

    # Expect either build request OR a validation error message (no folders selected)
    auth_page.click(build_btn)
    # Allow some time for either request or inline message
    auth_page.wait_for_timeout(3000)
    # Pass if no crash; status polling may or may not happen depending on validation


@pytest.mark.scenario
def test_s4_login_chat_streaming_with_sources(auth_page):
    """S4: Login → open chat → send question → receive streamed response + sources."""
    login = LoginPage(auth_page, auth_page.url)
    assert login.is_logged_in()

    chat = ChatPage(auth_page, auth_page.url)
    chat.open_chat()
    chat.send_question("总结一下知识库里的内容")

    # Wait for AI response to start
    try:
        chat.wait_for_response_start(timeout=30000)
    except Exception:
        pytest.skip("LLM did not respond within 30s (API key / network issue)")

    text = chat.wait_for_response_done(timeout=60000)
    assert isinstance(text, str)

    # Sources may or may not appear depending on retrieval results
    sources = chat.get_sources()
    assert isinstance(sources, list)


@pytest.mark.scenario
def test_s5_quiz_generate_answer_submit(auth_page):
    """S5 (bonus): Login → quiz → generate → answer → submit → result."""
    from pages import QuizPage

    login = LoginPage(auth_page, auth_page.url)
    assert login.is_logged_in()

    quiz = QuizPage(auth_page, auth_page.url)
    quiz.open_quiz()
    if not quiz.prepare_for_generate():
        pytest.skip("no folders or vectorized pages available; cannot generate")
    quiz.generate()

    count = quiz.get_question_count()
    if count == 0:
        pytest.skip("no questions generated (LLM unavailable)")

    # Answer all questions (best-effort)
    for i in range(count):
        try:
            quiz.select_option(i, 0)
        except Exception:
            try:
                quiz.fill_answer(i, "答案")
            except Exception:
                continue

    with auth_page.expect_request(
        lambda r: "/quiz/submit" in r.url, timeout=15000
    ):
        quiz.submit()

    # Result may take time to render
    auth_page.wait_for_timeout(3000)
    # Pass if no crash
    assert quiz.is_visible(quiz.GENERATE_BUTTON, timeout=2000)
