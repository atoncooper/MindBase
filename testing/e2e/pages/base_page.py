"""Base page object: shared helpers for all MindBase pages."""
from __future__ import annotations

import logging
import os
import time
from typing import Any

from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError

logger = logging.getLogger(__name__)

# Per-action delay (seconds) for visibility/recording. Set via ACTION_DELAY env.
ACTION_DELAY = float(os.getenv("ACTION_DELAY", "0.0"))


def _action_pause() -> None:
    """Pause briefly after an interaction for screen recording readability."""
    if ACTION_DELAY > 0:
        time.sleep(ACTION_DELAY)


class BasePage:
    """Common helpers: navigation, waits, safe clicks, screenshots."""

    def __init__(self, page: Page, base_url: str = "") -> None:
        self.page = page
        self.base_url = base_url.rstrip("/")

    # ----- navigation -----
    def open(self, path: str = "/") -> None:
        url = f"{self.base_url}{path}" if self.base_url else path
        logger.info("Navigate to %s", url)
        self.page.goto(url, wait_until="domcontentloaded")

    def reload(self) -> None:
        self.page.reload(wait_until="domcontentloaded")

    @property
    def url(self) -> str:
        return self.page.url

    @property
    def title(self) -> str:
        return self.page.title()

    # ----- waiting -----
    def wait_for_selector(
        self,
        selector: str,
        timeout: int | None = None,
        state: str | None = None,
    ) -> Any:
        kwargs: dict[str, Any] = {"timeout": timeout or 15000}
        if state is not None:
            kwargs["state"] = state
        return self.page.wait_for_selector(selector, **kwargs)

    def wait_for_text(self, text: str, timeout: int = 15000) -> None:
        self.page.wait_for_selector(f"text={text}", timeout=timeout)

    def wait_for_url_contains(self, fragment: str, timeout: int = 15000) -> None:
        self.page.wait_for_url(f"**{fragment}**", timeout=timeout)

    def wait_for_idle(self, timeout: int = 5000) -> None:
        """Wait for network idle (best-effort)."""
        try:
            self.page.wait_for_load_state("networkidle", timeout=timeout)
        except PlaywrightTimeoutError:
            logger.debug("networkidle not reached within %dms", timeout)

    # ----- interaction -----
    def click(self, selector: str, timeout: int | None = None) -> None:
        logger.debug("Click %s", selector)
        self.page.click(selector, timeout=timeout or 15000)
        _action_pause()

    def fill(self, selector: str, value: str) -> None:
        logger.debug("Fill %s", selector)
        self.page.fill(selector, value)
        _action_pause()

    def press(self, key: str) -> None:
        self.page.keyboard.press(key)
        _action_pause()

    def text(self, selector: str, timeout: int | None = None) -> str:
        return self.page.inner_text(selector, timeout=timeout or 15000)

    def is_visible(self, selector: str, timeout: int = 2000) -> bool:
        try:
            self.page.wait_for_selector(selector, timeout=timeout, state="visible")
            return True
        except PlaywrightTimeoutError:
            return False

    # ----- screenshot -----
    def screenshot(self, name: str) -> str:
        path = f"reports/screenshots/{name}.png"
        self.page.screenshot(path=path, full_page=True)
        logger.info("Screenshot saved to %s", path)
        return path

    def attach_screenshot(self, name: str) -> None:
        """Attach screenshot to allure report if allure is active."""
        try:
            import allure  # type: ignore

            allure.attach(
                self.page.screenshot(full_page=True),
                name=name,
                attachment_type=allure.attachment_type.PNG,
            )
        except Exception:
            pass
