"""Dock bar page object: opens module panels by clicking dock icons."""
from __future__ import annotations

import logging
from typing import Optional

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from .base_page import BasePage

logger = logging.getLogger(__name__)


# Dock icon titles defined in frontend/components/dock-modules/index.ts
DOCK_TITLES = {
    "chat": "对话",
    "chat-history": "历史会话",
    "quiz": "题目练习",
    "favorites": "收藏夹",
    "cloud-drive": "云盘",
    "settings": "API 设置",
    "account": "个人中心",
    "tasks": "任务监控",
    "billing": "用量计费",
}


class DockPage(BasePage):
    """Operates the bottom dock bar to open/close module panels."""

    DOCK_TRIGGER = ".dock-trigger-zone"
    DOCK_BAR = ".dock-bar"
    DOCK_ITEMS = ".dock-items"
    DOCK_BACKDROP = ".dock-backdrop"
    PANEL_WRAPPER = ".dock-panel-wrapper"

    def _dock_button(self, title: str) -> str:
        return f'{self.DOCK_ITEMS} button[aria-label="{title}"], .dock-icon:has-text("{title}")'

    def hover_to_show_dock(self) -> None:
        """Mouse over the bottom trigger zone to reveal the dock."""
        try:
            self.page.hover(self.DOCK_TRIGGER, timeout=3000)
        except PlaywrightTimeoutError:
            # Some layouts keep dock always-visible; fall back to direct hover
            self.page.hover(self.DOCK_BAR, timeout=3000)
        self.wait_for_selector(self.DOCK_ITEMS, state="visible", timeout=3000)

    def open_panel(self, module_id: str) -> None:
        """Open a dock module panel by module id (e.g. 'chat', 'favorites')."""
        title = DOCK_TITLES.get(module_id, module_id)
        logger.info("Open dock panel: %s", title)
        # Close any currently-open panel first to avoid AnimatePresence exit-animation
        # overlap (multiple .dock-panel-wrapper in DOM during transition).
        try:
            self.press("Escape")
            self.page.wait_for_selector(self.PANEL_WRAPPER, state="hidden", timeout=1000)
        except PlaywrightTimeoutError:
            pass
        self.hover_to_show_dock()
        btn_selector = self._dock_button(title)
        self.click(btn_selector)
        # Wait for panel attached (not "visible" — framer-motion initial state
        # scale:0.08/opacity:0 can make Playwright treat .dock-panel-wrapper as
        # hidden during enter animation). .floating-panel has explicit size.
        self.wait_for_selector(".floating-panel", timeout=5000)

    def close_active_panel(self) -> None:
        """Close the currently open dock panel via Escape or close button."""
        try:
            self.press("Escape")
            self.page.wait_for_selector(self.PANEL_WRAPPER, state="hidden", timeout=3000)
        except PlaywrightTimeoutError:
            logger.debug("Escape did not close panel; trying close button")

    def is_panel_open(self, timeout: int = 2000) -> bool:
        return self.is_visible(self.PANEL_WRAPPER, timeout=timeout)

    def get_active_panel_title(self) -> Optional[str]:
        if not self.is_panel_open(timeout=1000):
            return None
        try:
            return self.text(".panel-title", timeout=2000)
        except PlaywrightTimeoutError:
            return None
