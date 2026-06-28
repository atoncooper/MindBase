"""Quiz panel page object: generate, answer, submit, view results."""
from __future__ import annotations

import logging
import re
from typing import List, Optional

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from .base_page import BasePage

logger = logging.getLogger(__name__)


class QuizPage(BasePage):
    QUIZ_TITLE = "text=题目练习"
    GENERATE_BUTTON = "button:has-text('生成题目')"
    SUBMIT_BUTTON = "button:has-text('提交')"
    QUESTION_ITEM = ".quiz-question"
    QUESTION_TEXT = ".question-text"
    OPTION_ITEM = ".quiz-option"
    OPTION_LABEL = ".option-label"
    ANSWER_INPUT = '.quiz-answer-input, input[type="text"], textarea'
    SCORE_TEXT = ".quiz-score"
    RESULT_TEXT = ".quiz-result"

    # Mode tabs
    FOLDER_MODE_TAB = "button:has-text('按收藏夹')"
    PAGES_MODE_TAB = "button:has-text('按分P')"
    FOLDER_CHECKBOX = 'input[type="checkbox"]'
    PAGE_CHECKBOX = 'input[type="checkbox"]'
    HISTORY_TOGGLE = "button:has-text('题目历史')"

    def open_quiz(self) -> None:
        from .dock_page import DockPage

        dock = DockPage(self.page, self.base_url)
        dock.open_panel("quiz")
        self.wait_for_selector(self.GENERATE_BUTTON, timeout=5000)

    def prepare_for_generate(self) -> bool:
        """Select first available folder or page so the generate button enables.

        Returns True if content was selected, False if none available.
        """
        # Default mode is "folder"; try selecting first folder checkbox.
        if self._select_first_checkbox_in_folder_mode():
            return True
        # Fall back to pages mode.
        if self.is_visible(self.PAGES_MODE_TAB, timeout=2000):
            self.click(self.PAGES_MODE_TAB)
            # Wait for pages list to load (loader text disappears).
            try:
                self.page.wait_for_selector(
                    "text=加载分P列表", state="hidden", timeout=8000
                )
            except PlaywrightTimeoutError:
                logger.debug("pages loader not found or still visible")
            if self._select_first_checkbox_in_pages_mode():
                return True
        return False

    def _select_first_checkbox_in_folder_mode(self) -> bool:
        try:
            # "暂无收藏夹" empty state → no folders.
            if self.is_visible("text=暂无收藏夹", timeout=1000):
                return False
            checkboxes = self.page.query_selector_all(
                'label:has(input[type="checkbox"]) input[type="checkbox"]'
            )
            if not checkboxes:
                return False
            checkboxes[0].check(timeout=3000)
            return True
        except Exception as exc:
            logger.debug("folder selection failed: %s", exc)
            return False

    def _select_first_checkbox_in_pages_mode(self) -> bool:
        try:
            if self.is_visible("text=暂无已入库的分P", timeout=1000):
                return False
            checkboxes = self.page.query_selector_all(
                'label:has(input[type="checkbox"]) input[type="checkbox"]'
            )
            if not checkboxes:
                return False
            checkboxes[0].check(timeout=3000)
            return True
        except Exception as exc:
            logger.debug("page selection failed: %s", exc)
            return False

    def open_history(self) -> None:
        """Click the '题目历史' toggle to fetch /quiz/history."""
        self.click(self.HISTORY_TOGGLE)

    def generate(self) -> None:
        self.click(self.GENERATE_BUTTON)
        try:
            self.page.wait_for_selector(self.QUESTION_ITEM, timeout=20000)
        except PlaywrightTimeoutError:
            logger.warning("Quiz questions did not render after generate")

    def get_question_count(self) -> int:
        if not self.is_visible(self.QUESTION_ITEM, timeout=2000):
            return 0
        return len(self.page.query_selector_all(self.QUESTION_ITEM))

    def get_question_texts(self) -> List[str]:
        if not self.is_visible(self.QUESTION_ITEM, timeout=2000):
            return []
        items = self.page.query_selector_all(self.QUESTION_TEXT)
        return [el.inner_text().strip() for el in items]

    def select_option(self, question_index: int, option_index: int) -> None:
        questions = self.page.query_selector_all(self.QUESTION_ITEM)
        if question_index >= len(questions):
            raise IndexError(f"question_index {question_index} out of range ({len(questions)})")
        opts = questions[question_index].query_selector_all(self.OPTION_ITEM)
        if option_index >= len(opts):
            raise IndexError(f"option_index {option_index} out of range ({len(opts)})")
        opts[option_index].click()

    def fill_answer(self, question_index: int, text: str) -> None:
        questions = self.page.query_selector_all(self.QUESTION_ITEM)
        if question_index >= len(questions):
            raise IndexError(f"question_index {question_index} out of range ({len(questions)})")
        inp = questions[question_index].query_selector(self.ANSWER_INPUT)
        if inp is None:
            raise PlaywrightTimeoutError("Answer input not found for question")
        inp.fill(text)

    def submit(self) -> None:
        self.click(self.SUBMIT_BUTTON)

    def get_score(self) -> Optional[int]:
        if not self.is_visible(self.SCORE_TEXT, timeout=5000):
            return None
        text = self.text(self.SCORE_TEXT)
        m = re.search(r"(\d+)", text)
        return int(m.group(1)) if m else None

    def has_result(self, timeout: int = 5000) -> bool:
        return self.is_visible(self.RESULT_TEXT, timeout=timeout)
