"""Pytest fixtures for MindBase E2E tests (Playwright)."""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Generator

import pytest
from dotenv import load_dotenv
from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

# Ensure project root on sys.path for utils import
ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

load_dotenv(ROOT / ".env")

BASE_URL = os.getenv("BASE_URL", "http://localhost:3000").rstrip("/")
API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:8000").rstrip("/")
LOGIN_METHOD = os.getenv("LOGIN_METHOD", "password")
STORAGE_STATE = ROOT / os.getenv("STORAGE_STATE", "data/auth.json")
DEFAULT_TIMEOUT = int(os.getenv("DEFAULT_TIMEOUT", "15000"))
NAV_TIMEOUT = int(os.getenv("NAV_TIMEOUT", "30000"))


@pytest.fixture(scope="session")
def base_url() -> str:
    return BASE_URL


@pytest.fixture(scope="session")
def api_base_url() -> str:
    return API_BASE_URL


@pytest.fixture(scope="session")
def browser_name() -> str:
    return os.getenv("BROWSER", "chromium")


@pytest.fixture(scope="session")
def browser_channel() -> str | None:
    # Use system Chrome to avoid downloading playwright bundled chromium.
    # Override via env var if needed (e.g. "msedge" or empty for bundled chromium).
    return os.getenv("BROWSER_CHANNEL", "chrome") or None


@pytest.fixture(scope="session")
def playwright_session():
    """Launch playwright once per session."""
    with sync_playwright() as p:
        yield p


@pytest.fixture(scope="session")
def browser(
    playwright_session, browser_name: str, browser_channel: str | None
) -> Generator[Browser, None, None]:
    launch_kwargs: dict[str, Any] = {"headless": False}
    if browser_channel:
        launch_kwargs["channel"] = browser_channel
    browser = playwright_session[browser_name].launch(**launch_kwargs)
    yield browser
    browser.close()


@pytest.fixture(scope="session")
def storage_state_path() -> Path:
    """Ensure storage state dir exists; return target path."""
    STORAGE_STATE.parent.mkdir(parents=True, exist_ok=True)
    return STORAGE_STATE


@pytest.fixture
def context(browser: Browser, storage_state_path: Path) -> Generator[BrowserContext, None, None]:
    """Browser context with optional saved storage state for session reuse."""
    context_kwargs: dict[str, Any] = {
        "viewport": {"width": 1440, "height": 900},
        "base_url": BASE_URL,
    }
    # Auto-reuse saved storage state from prior login to avoid repeated auth calls
    if storage_state_path.exists():
        context_kwargs["storage_state"] = str(storage_state_path)
    elif LOGIN_METHOD == "storage_state":
        pytest.skip("storage_state mode but no saved auth.json; run one password login first")

    ctx = browser.new_context(**context_kwargs)
    ctx.set_default_timeout(DEFAULT_TIMEOUT)
    ctx.set_default_navigation_timeout(NAV_TIMEOUT)
    yield ctx
    ctx.close()


@pytest.fixture
def page(context: BrowserContext) -> Generator[Page, None, None]:
    p = context.new_page()
    yield p
    p.close()


@pytest.fixture
def auth_page(page: Page, storage_state_path: Path) -> Page:
    """Page that is already authenticated.

    Strategy:
    1. If saved storage_state exists and session still valid → reuse (no login call).
    2. Otherwise do password login once and persist storage_state for later tests.
    """
    # Try reused state first
    if storage_state_path.exists():
        page.goto(BASE_URL, wait_until="domcontentloaded")
        try:
            page.wait_for_function(
                "() => !!localStorage.getItem('bili_session')",
                timeout=5000,
            )
            return page  # session alive, no login needed
        except Exception:
            # Saved state stale — fall through to password login
            storage_state_path.unlink(missing_ok=True)

    if LOGIN_METHOD != "password":
        pytest.skip("password login not enabled (set LOGIN_METHOD=password in .env)")

    email = os.getenv("TEST_EMAIL")
    password = os.getenv("TEST_PASSWORD")
    if not email or not password or "change-me" in password:
        pytest.skip("TEST_EMAIL/TEST_PASSWORD not configured in .env")

    from pages.login_page import LoginPage

    login = LoginPage(page, BASE_URL)
    login.open()
    login.open_password_modal()
    login.login_with_password(email, password)
    login.wait_for_login_success()

    # Persist storage state so subsequent tests skip login (avoids 429)
    try:
        page.context.storage_state(path=str(storage_state_path))
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("Failed to save storage_state: %s", exc)
    return page


# ---- Markers registration (safety net) ----
def pytest_configure(config: pytest.Config) -> None:
    for marker in [
        "smoke: minimal sanity checks",
        "m1_auth: authentication module",
        "m2_favorites: favorites management module",
        "m3_knowledge: knowledge base build module",
        "m4_chat: chat / RAG module",
        "m5_quiz: quiz training module",
        "scenario: end-to-end business scenario",
        "slow: long-running tests",
    ]:
        config.addinivalue_line("markers", marker)
