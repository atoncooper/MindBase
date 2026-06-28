"""Knowledge panel page object: stats, build trigger, status polling."""
from __future__ import annotations

import logging
import re
from typing import Optional

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from .base_page import BasePage

logger = logging.getLogger(__name__)


class KnowledgePage(BasePage):
    # Knowledge stats are rendered inside ChatPanel header via knowledgeApi.getStats
    STATS_SELECTOR = ".knowledge-stats"
    STATS_TEXT_PATTERN = re.compile(r"(\d+)")

    # Build button is inside favorites panel. Button text is dynamic:
    # "选择收藏夹" (nothing selected) / "入库 (N)" (selected) / "处理中..." (building)
    BUILD_BUTTON = "button.btn-primary:has-text('入库')"
    BUILD_BUTTON_ALT = "button.btn-primary:has-text('选择收藏夹')"
    PROGRESS_BAR = ".progress-bar"
    PROGRESS_TEXT = ".progress-text"

    def open_knowledge_stats(self) -> None:
        """Open chat panel (where stats are shown) to read knowledge stats."""
        from .dock_page import DockPage

        dock = DockPage(self.page, self.base_url)
        dock.open_panel("chat")
        # Wait for stats to render
        try:
            self.page.wait_for_selector(self.STATS_SELECTOR, timeout=10000)
        except PlaywrightTimeoutError:
            logger.info("Knowledge stats selector not found; may be empty state")

    def get_stats_text(self) -> Optional[str]:
        if not self.is_visible(self.STATS_SELECTOR, timeout=3000):
            return None
        return self.text(self.STATS_SELECTOR)

    def get_total_chunks(self) -> Optional[int]:
        text = self.get_stats_text()
        if not text:
            return None
        m = self.STATS_TEXT_PATTERN.search(text)
        return int(m.group(1)) if m else None

    def trigger_build(self) -> None:
        """Click build button inside favorites panel."""
        from .dock_page import DockPage

        dock = DockPage(self.page, self.base_url)
        dock.open_panel("favorites")
        # Try primary or alt button text
        for selector in (self.BUILD_BUTTON, self.BUILD_BUTTON_ALT):
            if self.is_visible(selector, timeout=2000):
                self.click(selector)
                return
        raise PlaywrightTimeoutError("Build button not found in favorites panel")

    def wait_for_build_progress(self, timeout: int = 10000) -> bool:
        """Return True if progress indicator appears."""
        try:
            self.page.wait_for_selector(self.PROGRESS_TEXT, timeout=timeout)
            return True
        except PlaywrightTimeoutError:
            return False
