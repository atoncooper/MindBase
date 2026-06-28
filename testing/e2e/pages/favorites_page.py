"""Favorites panel page object: list, multi-select, sync, organize."""
from __future__ import annotations

import logging
import re
from typing import List

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from .base_page import BasePage

logger = logging.getLogger(__name__)


class FavoritesPage(BasePage):
    PANEL_TITLE = "text=收藏夹"
    PANEL_SUBTITLE = ".panel-subtitle"
    REFRESH_BUTTON = "button:has-text('刷新')"
    ORGANIZE_BUTTON = "button:has-text('快速整理默认收藏夹')"
    LOADING_TEXT = "text=加载中..."
    FOLDER_ITEM = ".folder-card"
    FOLDER_CHECKBOX = '.folder-card input[type="checkbox"]'
    FOLDER_TITLE = ".folder-title"
    FOLDER_COUNT = ".folder-count"

    def open_favorites(self) -> None:
        """Open favorites panel via dock."""
        from .dock_page import DockPage

        dock = DockPage(self.page, self.base_url)
        dock.open_panel("favorites")
        self.wait_for_selector(self.PANEL_TITLE, timeout=5000)

    def wait_for_folders_loaded(self, timeout: int = 15000) -> None:
        """Wait until loading text disappears and folder items are visible."""
        try:
            self.page.wait_for_selector(self.LOADING_TEXT, state="hidden", timeout=timeout)
        except PlaywrightTimeoutError:
            logger.debug("No loading indicator found; continue")
        # Wait for at least one folder item OR an empty state
        try:
            self.page.wait_for_selector(self.FOLDER_ITEM, timeout=timeout)
        except PlaywrightTimeoutError:
            logger.info("No folder items; might be empty state")

    def get_folder_count(self) -> int:
        try:
            subtitle = self.text(self.PANEL_SUBTITLE, timeout=3000)
            # Subtitle pattern: "N 个"
            m = re.search(r"(\d+)", subtitle)
            return int(m.group(1)) if m else 0
        except PlaywrightTimeoutError:
            return 0

    def get_folder_titles(self) -> List[str]:
        if not self.is_visible(self.FOLDER_ITEM, timeout=2000):
            return []
        items = self.page.query_selector_all(self.FOLDER_ITEM)
        titles: List[str] = []
        for item in items:
            try:
                t = item.inner_text(self.FOLDER_TITLE)
                titles.append(t.strip())
            except Exception:
                continue
        return titles

    def select_folder_by_title(self, title: str) -> None:
        logger.info("Select folder: %s", title)
        self.click(f'{self.FOLDER_ITEM}:has-text("{title}")')

    def refresh(self) -> None:
        self.click(self.REFRESH_BUTTON)
        self.wait_for_folders_loaded()

    def open_organize_preview(self) -> None:
        self.click(self.ORGANIZE_BUTTON)
        # OrganizePreviewModal appears (title is "一键整理预览").
        # If there's no default folder, the button may no-op; tolerate that.
        try:
            self.page.wait_for_selector("text=整理预览", timeout=5000)
        except PlaywrightTimeoutError:
            logger.info("organize preview modal did not open (no default folder?)")

    def wait_for_organize_preview_loaded(self, timeout: int = 15000) -> None:
        """Wait until the organize preview finishes loading (stats visible or empty state)."""
        # Loading state shows "正在生成预览..."
        try:
            self.page.wait_for_selector(
                "text=正在生成预览", state="hidden", timeout=timeout
            )
        except PlaywrightTimeoutError:
            logger.debug("organize preview loader not found or still visible")
        # Wait for stats span to appear (renders only when preview data is ready)
        try:
            self.page.wait_for_selector(".organize-stats", timeout=timeout)
        except PlaywrightTimeoutError:
            logger.info("organize stats not rendered; preview may be empty")

    def get_organize_stats(self) -> dict:
        """Parse stats from organize preview modal.

        Frontend renders: "总计 {n}", "已匹配 {n}", "未匹配 {n}" (space, no colon).
        """
        self.wait_for_organize_preview_loaded()
        text = self.page.inner_text("body")
        stats: dict = {}
        m_total = re.search(r"总计\s*(\d+)", text)
        m_matched = re.search(r"已匹配\s*(\d+)", text)
        m_unmatched = re.search(r"未匹配\s*(\d+)", text)
        if m_total:
            stats["total"] = int(m_total.group(1))
        if m_matched:
            stats["matched"] = int(m_matched.group(1))
        if m_unmatched:
            stats["unmatched"] = int(m_unmatched.group(1))
        return stats
