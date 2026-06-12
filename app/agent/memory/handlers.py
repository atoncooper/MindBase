"""Error classification, retry strategy, and fallback handling.

Agent-agnostic — used by any agent graph that needs error_node support.
"""

from __future__ import annotations

import asyncio
import logging
from enum import Enum
from typing import Sequence

from app.agent.memory.state import AgentState

logger = logging.getLogger(__name__)

FALLBACK_RESULT = "检索服务暂时不可用，请稍后再试。"


def build_fallback(state: AgentState) -> dict:
    """Return a state update dict with fallback result and error field set."""
    return {
        "result": FALLBACK_RESULT,
        "error": state.error or "unknown error",
    }


class ErrorCategory(Enum):
    RETRYABLE = "retryable"
    NON_RETRYABLE = "non_retryable"
    FATAL = "fatal"


_RETRYABLE_PATTERNS: Sequence[str] = [
    "timeout",
    "connection",
    "try again",
    "rate limit",
    "too many",
    "temporarily",
    "service unavailable",
    "eof",
    "reset",
    "retryable",
    "deadline exceeded",
    "too many requests",
    "internal server error",
    "503",
    "502",
    "500",
]

_FATAL_PATTERNS: Sequence[str] = [
    "authentication",
    "unauthorized",
    "invalid api key",
    "permission denied",
    "forbidden",
    "account suspended",
    "access denied",
]


def classify_error(error_message: str) -> ErrorCategory:
    """Categorise an error string into RETRYABLE, NON_RETRYABLE, or FATAL."""
    error_lower = error_message.lower()
    for p in _FATAL_PATTERNS:
        if p in error_lower:
            return ErrorCategory.FATAL
    for p in _RETRYABLE_PATTERNS:
        if p in error_lower:
            return ErrorCategory.RETRYABLE
    return ErrorCategory.NON_RETRYABLE


async def backoff_delay(attempt: int, base_seconds: float = 1.0) -> None:
    """Exponential backoff: sleep base * 2^attempt seconds (capped at 10)."""
    delay = min(base_seconds * (2**attempt), 10.0)
    logger.debug("[BACKOFF] sleeping %.2fs (attempt %s)", delay, attempt)
    await asyncio.sleep(delay)


def as_error_node(node_name: str) -> callable:
    """Decorator that wraps a LangGraph node function with error handling.

    On success: returns original result with ``error`` cleared.
    On exception: returns dict with ``error``, ``failed_node`` set.
    """

    def _report_error(state: AgentState, error_msg: str) -> dict:
        return {"error": error_msg, "failed_node": node_name}

    def decorator(func):
        async def wrapper(state: AgentState, **kwargs) -> dict:
            try:
                result = await func(state, **kwargs)
                if isinstance(result, dict):
                    result.setdefault("error", "")
                    result.setdefault("retry_count", state.retry_count)
                return result
            except Exception as exc:
                logger.warning(
                    "[MEM_AGENT] %s failed: %s (retry %s/%s)",
                    node_name,
                    exc,
                    state.retry_count,
                    state.max_retries,
                )
                return _report_error(state, str(exc))

        return wrapper

    return decorator
