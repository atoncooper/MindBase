"""Configuration for the context management module."""

from dataclasses import dataclass, field


@dataclass
class ContextConfig:
    """Configuration for ContextManager and its components.

    Attributes:
        max_turns: Maximum conversation turns kept in the sliding window.
                   One turn = one user message + one assistant response.
        max_messages: Alternative cap — max total messages (0 = unlimited,
                      takes precedence over max_turns when > 0).
        ttl_seconds: Time-to-live for an idle session in seconds.
                     Sessions not updated within this window are eligible
                     for eviction. 0 = never expire.
        max_sessions: Maximum number of concurrent sessions in memory.
                      0 = unlimited.
        cleanup_interval: Seconds between background cleanup passes.
                          0 = disable background cleanup (lazy-only).
    """

    max_turns: int = 20
    max_messages: int = 0
    ttl_seconds: int = 900  # 15 minutes idle → evict
    max_sessions: int = 10000
    cleanup_interval: int = 120  # background sweep every 2 minutes


# Sensible defaults that can be overridden per deployment.
DEFAULT_CONFIG = ContextConfig()
