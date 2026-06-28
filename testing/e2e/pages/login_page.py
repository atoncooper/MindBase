"""Login page object: handles QR + password login modals."""
from __future__ import annotations

import logging
from typing import Optional

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from .base_page import BasePage

logger = logging.getLogger(__name__)


class LoginPage(BasePage):
    # Selectors (kept as constants for easy maintenance)
    QR_MODAL = ".modal-backdrop"
    QR_IMAGE = 'img[alt="QR Code"]'
    QR_LOADING = ".animate-spin"
    QR_STATUS_SCANNED = "text=已扫码"
    QR_STATUS_SUCCESS = "text=登录成功"
    QR_STATUS_EXPIRED = "text=二维码已过期"
    QR_RETRY_BUTTON = "text=重新获取"

    # Password modal selectors (Google-style inputs lack data-testid; use labels)
    PASSWORD_MODAL = '[role="dialog"]'
    EMAIL_INPUT = 'input[type="email"]'
    PASSWORD_INPUT = 'input[type="password"]'
    SUBMIT_BUTTON = 'button[type="submit"]:has-text("下一步")'
    SWITCH_TO_QR_BUTTON = "text=使用扫码登录"
    # Scope alert to within the password dialog to avoid matching global toasts.
    PASSWORD_ERROR = '[role="dialog"] [role="alert"]'
    LOGIN_TITLE = "#password-login-title"

    # Top-level entry: home page shows hero buttons to open modals (no auto-open)
    SESSION_STORAGE_KEY = "bili_session"
    HERO_QR_BUTTON = "text=扫码登录开始构建"
    HERO_PASSWORD_BUTTON = "text=账号登录"

    def open(self) -> "LoginPage":
        # Clear any restored storage_state so unauthenticated tests start clean.
        # storage_state is applied at context creation, so we must navigate first
        # to the origin whose localStorage we want to clear, then reload.
        super().open("/")
        try:
            self.page.evaluate(
                "() => { localStorage.removeItem('bili_session'); "
                "localStorage.removeItem('bili_user'); "
                "localStorage.removeItem('bili_chat_session'); }"
            )
            self.page.reload(wait_until="domcontentloaded")
        except Exception:
            logger.debug("localStorage clear after open failed; continue")
        return self

    def open_login_via_hero(self, mode: str = "qr") -> None:
        """Open login modal by clicking hero button on unauthenticated home.

        Args:
            mode: "qr" clicks 扫码登录开始构建; "password" clicks 账号登录.
        """
        selector = self.HERO_QR_BUTTON if mode == "qr" else self.HERO_PASSWORD_BUTTON
        self.click(selector, timeout=5000)

    # ----- QR login -----
    def open_qr_modal(self) -> None:
        """If QR modal is not auto-opened, trigger via login entry."""
        if not self.is_visible(self.QR_MODAL, timeout=2000):
            # Try clicking any "登录" entry if present (depends on app state)
            try:
                self.click("text=扫码登录", timeout=2000)
            except PlaywrightTimeoutError:
                logger.info("QR modal already open or no entry needed")

    def wait_for_qr_image(self, timeout: int = 10000) -> None:
        self.wait_for_selector(self.QR_IMAGE, timeout=timeout)
        # spin should disappear
        self.page.wait_for_selector(self.QR_LOADING, state="hidden", timeout=timeout)

    def get_qr_status(self, timeout: int = 5000) -> str:
        """Return current QR login status: loading/ready/scanned/success/expired."""
        if self.is_visible(self.QR_STATUS_SUCCESS, timeout=500):
            return "success"
        if self.is_visible(self.QR_STATUS_SCANNED, timeout=500):
            return "scanned"
        if self.is_visible(self.QR_STATUS_EXPIRED, timeout=500):
            return "expired"
        if self.is_visible(self.QR_IMAGE, timeout=500):
            return "ready"
        return "loading"

    # ----- Password login (automation-friendly) -----
    def open_password_modal(self) -> None:
        """Open password login modal via hero entry on unauthenticated home."""
        if not self.is_visible(self.PASSWORD_MODAL, timeout=1000):
            self.open_login_via_hero(mode="password")
        self.wait_for_selector(self.PASSWORD_MODAL, timeout=5000)

    def login_with_password(self, email: str, password: str) -> None:
        logger.info("Password login as %s", email)
        self.page.fill(self.EMAIL_INPUT, email)
        self.page.fill(self.PASSWORD_INPUT, password)
        self.page.click(self.SUBMIT_BUTTON)

    def wait_for_login_success(self, timeout: int = 15000) -> None:
        """Wait until localStorage has bili_session and modal closes."""
        self.page.wait_for_function(
            "() => !!localStorage.getItem('bili_session')",
            timeout=timeout,
        )
        # Ensure modal closed
        try:
            self.page.wait_for_selector(self.PASSWORD_MODAL, state="hidden", timeout=5000)
        except PlaywrightTimeoutError:
            logger.warning("Password modal still visible after login")

    def get_password_error(self, timeout: int = 3000) -> Optional[str]:
        # Check modal-scoped alert first, then fall back to any alert on page
        # (backend may surface rate-limit / generic errors as a global toast).
        for selector in (self.PASSWORD_ERROR, '[role="alert"]'):
            if self.is_visible(selector, timeout=timeout):
                try:
                    return self.text(selector).strip()
                except PlaywrightTimeoutError:
                    continue
        return None

    def is_logged_in(self) -> bool:
        return self.page.evaluate(
            "() => !!localStorage.getItem('bili_session')"
        )

    def logout(self) -> None:
        """Clear localStorage and reload to reset session."""
        self.page.evaluate(
            "() => { localStorage.removeItem('bili_session'); "
            "localStorage.removeItem('bili_user'); "
            "localStorage.removeItem('bili_chat_session'); }"
        )
        self.reload()
