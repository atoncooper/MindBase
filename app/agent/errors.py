"""Agent-agnostic error classification.

Used by agent graphs (``error_node`` retry/fallback decisions) and by the
harness scheduler (retry policy).  Kept dependency-free - no langgraph, no
agent state - so the scheduler can import it without pulling in the full
agent stack (``app.agent.memory.__init__`` imports langgraph).
"""

from __future__ import annotations

from enum import Enum
from typing import Sequence


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
