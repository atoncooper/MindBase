"""Circuit breaker — shared across all agents.

Prevents cascading failures by temporarily rejecting requests when
consecutive errors exceed a threshold.
"""

from __future__ import annotations

import logging
import time
from enum import Enum

logger = logging.getLogger(__name__)


class CircuitState(Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class CircuitBreaker:
    """Circuit breaker with configurable threshold and cooldown.

    State machine::

        CLOSED ──(failures >= threshold)──▶ OPEN
        OPEN   ──(cooldown elapsed)────────▶ HALF_OPEN
        HALF_OPEN ──(next success)─────────▶ CLOSED
        HALF_OPEN ──(next failure)─────────▶ OPEN
    """

    def __init__(
        self,
        *,
        failure_threshold: int = 3,
        cooldown_seconds: float = 30.0,
        name: str = "default",
    ) -> None:
        self._failure_threshold = failure_threshold
        self._cooldown = cooldown_seconds
        self._name = name
        self._failure_count = 0
        self._state = CircuitState.CLOSED
        self._last_open_time = 0.0

    @property
    def state(self) -> CircuitState:
        if self._state is CircuitState.OPEN:
            elapsed = time.monotonic() - self._last_open_time
            if elapsed >= self._cooldown:
                logger.info("[CIRCUIT:%s] OPEN → HALF_OPEN", self._name)
                self._state = CircuitState.HALF_OPEN
        return self._state

    @property
    def failure_count(self) -> int:
        return self._failure_count

    @property
    def is_tripped(self) -> bool:
        return self.state is CircuitState.OPEN

    def record_success(self) -> None:
        if self._state is CircuitState.HALF_OPEN:
            logger.info("[CIRCUIT:%s] HALF_OPEN → CLOSED", self._name)
        self._failure_count = 0
        self._state = CircuitState.CLOSED

    def record_failure(self) -> bool:
        self._failure_count += 1
        threshold_met = self._failure_count >= self._failure_threshold
        if threshold_met and self._state is not CircuitState.OPEN:
            self._state = CircuitState.OPEN
            self._last_open_time = time.monotonic()
            logger.warning(
                "[CIRCUIT:%s] OPEN (failures=%s/%s)",
                self._name,
                self._failure_count,
                self._failure_threshold,
            )
            return True
        return False

    def reset(self) -> None:
        self._failure_count = 0
        self._state = CircuitState.CLOSED
        self._last_open_time = 0.0
        logger.info("[CIRCUIT:%s] reset", self._name)
