"""Error classification, retry, fallback for the Summary Agent.

Agent-agnostic pieces (classify_error, ErrorCategory) are reused from
``app.agent.errors``; only the fallback string is summary-specific.
"""

from __future__ import annotations

import asyncio
import logging

from app.agent.errors import ErrorCategory, classify_error  # noqa: F401 (re-exported)
from app.agent.summary.state import SummaryAgentState

logger = logging.getLogger(__name__)

FALLBACK_RESULT = "总结服务暂时不可用，请稍后再试。"


def build_fallback(state: SummaryAgentState) -> dict:
    return {"result": FALLBACK_RESULT, "error": state.error or "unknown error"}


async def backoff_delay(attempt: int, base_seconds: float = 1.0) -> None:
    delay = min(base_seconds * (2**attempt), 10.0)
    logger.debug("[BACKOFF] sleeping %.2fs (attempt %s)", delay, attempt)
    await asyncio.sleep(delay)


def as_error_node(node_name: str):
    """Wrap a LangGraph node with error handling (sets state.error/failed_node)."""

    def _report_error(state: SummaryAgentState, error_msg: str) -> dict:
        return {"error": error_msg, "failed_node": node_name}

    def decorator(func):
        async def wrapper(state: SummaryAgentState, **kwargs) -> dict:
            try:
                result = await func(state, **kwargs)
                if isinstance(result, dict):
                    result.setdefault("error", "")
                    result.setdefault("retry_count", state.retry_count)
                return result
            except Exception as exc:
                logger.warning(
                    "[SUMMARY_AGENT] %s failed: %s (retry %s/%s)",
                    node_name,
                    exc,
                    state.retry_count,
                    state.max_retries,
                )
                return _report_error(state, str(exc))

        return wrapper

    return decorator
