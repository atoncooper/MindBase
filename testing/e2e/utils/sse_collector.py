"""SSE event collector: parse a ReadableStream from /chat/ask/stream.

Usage:
    events = collect_sse_events(page, lambda: chat.send_question("hi"))
    # events is a list of {"type": "chunk"|"sources"|"done"|"error", ...}
"""
from __future__ import annotations

import json
import logging
from typing import Callable, List

from playwright.sync_api import Page

logger = logging.getLogger(__name__)


def collect_sse_events(
    page: Page,
    trigger: Callable[[], None],
    url_fragment: str = "/chat/ask",
    timeout: int = 30000,
) -> List[dict]:
    """Trigger an action and collect SSE events from the matching response.

    Returns a list of parsed event dicts. On any parse error, the raw line is
    included as {"type": "raw", "content": "..."}.
    """
    events: List[dict] = []

    def on_response(response):
        if url_fragment not in response.url:
            return
        if response.request.method != "POST":
            return
        try:
            body = response.text()
        except Exception as e:
            logger.warning("Failed to read SSE body: %s", e)
            return
        for line in body.splitlines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            payload = line[len("data:"):].strip()
            try:
                events.append(json.loads(payload))
            except json.JSONDecodeError:
                events.append({"type": "raw", "content": payload})

    page.on("response", on_response)
    try:
        trigger()
        page.wait_for_timeout(timeout)
    finally:
        try:
            page.remove_listener("response", on_response)
        except Exception:
            pass
    return events
