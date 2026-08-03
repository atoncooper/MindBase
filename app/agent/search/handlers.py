"""Error classification, retry, fallback for the Search Agent."""

from __future__ import annotations

import asyncio
import logging

from app.agent.errors import ErrorCategory, classify_error  # noqa: F401

from app.agent.search.state import SearchAgentState

logger = logging.getLogger(__name__)

FALLBACK_RESULT = "文档搜索服务暂时不可用，请稍后再试。"


def build_fallback(state: SearchAgentState) -> dict:
    return {"result": FALLBACK_RESULT, "error": state.error or "unknown error"}


async def backoff_delay(attempt: int, base_seconds: float = 1.0) -> None:
    delay = min(base_seconds * (2**attempt), 10.0)
    await asyncio.sleep(delay)


def as_error_node(node_name: str):
    def _report_error(state: SearchAgentState, error_msg: str) -> dict:
        return {"error": error_msg, "failed_node": node_name}

    def decorator(func):
        async def wrapper(state: SearchAgentState, **kwargs) -> dict:
            try:
                result = await func(state, **kwargs)
                if isinstance(result, dict):
                    result.setdefault("error", "")
                    result.setdefault("retry_count", state.retry_count)
                return result
            except Exception as exc:
                logger.warning(
                    "[SEARCH_AGENT] %s failed: %s (retry %s/%s)",
                    node_name, exc, state.retry_count, state.max_retries,
                )
                return _report_error(state, str(exc))
        return wrapper
    return decorator
