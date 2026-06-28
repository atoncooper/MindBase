"""Chat panel page object: message list, input, SSE stream handling."""
from __future__ import annotations

import logging
from typing import List, Optional

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from .base_page import BasePage

logger = logging.getLogger(__name__)


class ChatPage(BasePage):
    INPUT_SELECTOR = 'textarea[placeholder="输入你的问题..."]'
    SEND_BUTTON = 'button[aria-label="发送消息"]'
    MESSAGE_BUBBLE = ".msg-row"
    USER_MESSAGE = ".msg-user-pill"
    AI_MESSAGE = ".msg-assistant-body"
    SOURCES_LIST = ".msg-source-mini"
    SOURCE_LINK = ".msg-source-mini"
    CLEAR_BUTTON = "button:has-text('清空')"
    STATS_TEXT = ".knowledge-stats"
    ERROR_ALERT = '[role="alert"]'

    def open_chat(self) -> None:
        from .dock_page import DockPage

        dock = DockPage(self.page, self.base_url)
        dock.open_panel("chat")
        self.wait_for_selector(self.INPUT_SELECTOR, timeout=5000)

    def wait_for_chat_session(self, timeout: int = 15000) -> None:
        """Wait for bili_chat_session in localStorage so send() doesn't no-op.

        The React effect that creates the chat session runs after mount; if we
        call send() before chatSessionId propagates to context, send() returns
        early and /chat/ask is never fired.
        """
        try:
            self.page.wait_for_function(
                "() => !!localStorage.getItem('bili_chat_session')",
                timeout=timeout,
            )
        except PlaywrightTimeoutError:
            logger.warning("bili_chat_session not set within %dms", timeout)
        # Allow React state to propagate after localStorage is set.
        self.page.wait_for_timeout(300)

    def send_question(self, question: str) -> None:
        logger.info("Send question: %s", question)
        self.wait_for_chat_session()
        self.page.fill(self.INPUT_SELECTOR, question)
        self.page.click(self.SEND_BUTTON)

    def send_via_enter(self, question: str) -> None:
        self.wait_for_chat_session()
        self.page.fill(self.INPUT_SELECTOR, question)
        self.page.keyboard.press("Enter")

    def wait_for_response_start(self, timeout: int = 20000) -> None:
        """Wait for AI bubble to appear and contain any text."""
        self.page.wait_for_selector(self.AI_MESSAGE, timeout=timeout)

    def wait_for_response_done(self, timeout: int = 60000) -> str:
        """Wait until SSE stream completes (input re-enabled) and return text."""
        # Loading indicator (spinner) appears during streaming
        try:
            self.page.wait_for_selector(
                ".animate-spin", state="hidden", timeout=timeout
            )
        except PlaywrightTimeoutError:
            logger.warning("Spinner still visible after %dms", timeout)
        # Return concatenated AI text
        return self.get_last_ai_response()

    def get_messages(self) -> List[str]:
        if not self.is_visible(self.MESSAGE_BUBBLE, timeout=2000):
            return []
        els = self.page.query_selector_all(self.MESSAGE_BUBBLE)
        return [el.inner_text().strip() for el in els]

    def get_last_ai_response(self) -> str:
        try:
            els = self.page.query_selector_all(self.AI_MESSAGE)
            return els[-1].inner_text().strip() if els else ""
        except Exception:
            return ""

    def get_sources(self) -> List[dict]:
        """Return list of {title, href} from the sources panel."""
        if not self.is_visible(self.SOURCE_LINK, timeout=2000):
            return []
        links = self.page.query_selector_all(self.SOURCE_LINK)
        sources: List[dict] = []
        for a in links:
            try:
                sources.append({"title": a.inner_text().strip(), "url": a.get_attribute("href") or ""})
            except Exception:
                continue
        return sources

    def wait_for_sources(self, timeout: int = 20000) -> List[dict]:
        try:
            self.page.wait_for_selector(self.SOURCE_LINK, timeout=timeout)
        except PlaywrightTimeoutError:
            return []
        return self.get_sources()

    def clear_messages(self) -> None:
        try:
            self.page.click(self.CLEAR_BUTTON, timeout=3000)
        except PlaywrightTimeoutError:
            logger.debug("Clear button not found; skip")

    def has_error(self, timeout: int = 2000) -> Optional[str]:
        if not self.is_visible(self.ERROR_ALERT, timeout=timeout):
            return None
        return self.text(self.ERROR_ALERT)

    def get_stats_text(self) -> Optional[str]:
        if not self.is_visible(self.STATS_TEXT, timeout=2000):
            return None
        return self.text(self.STATS_TEXT)
