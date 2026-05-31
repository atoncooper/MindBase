"""
Thread-safe Snowflake ID generator (async-safe with asyncio.Lock).

Layout (64 bits):
  [1 reserved] [41 ms timestamp] [10 worker] [12 sequence]
"""

import asyncio
import os
import time

# 2025-01-01T00:00:00Z in ms
_EPOCH_MS = 1735689600000

_WORKER_BITS = 10
_SEQUENCE_BITS = 12
_MAX_WORKER = (1 << _WORKER_BITS) - 1
_MAX_SEQUENCE = (1 << _SEQUENCE_BITS) - 1

_TIMESTAMP_SHIFT = _WORKER_BITS + _SEQUENCE_BITS
_WORKER_SHIFT = _SEQUENCE_BITS


def _now_ms() -> int:
    return int(time.time() * 1000)


class SnowflakeGenerator:
    """Async-safe Snowflake ID generator."""

    def __init__(self, worker_id: int = 1) -> None:
        if not (0 <= worker_id <= _MAX_WORKER):
            raise ValueError(f"worker_id must be 0..{_MAX_WORKER}, got {worker_id}")
        self._worker_id = worker_id
        self._lock = asyncio.Lock()
        self._last_ms = -1
        self._sequence = 0

    async def next_id(self) -> int:
        """Generate the next unique ID."""
        async with self._lock:
            now = _now_ms()
            if now == self._last_ms:
                self._sequence = (self._sequence + 1) & _MAX_SEQUENCE
                if self._sequence == 0:
                    # sequence exhausted this ms, wait for next ms
                    while _now_ms() <= self._last_ms:
                        await asyncio.sleep(0)
                    now = _now_ms()
            else:
                self._sequence = 0

            self._last_ms = now
            timestamp = (now - _EPOCH_MS) & 0x1FFFFFFFFFF  # 41 bits
            return (
                (timestamp << _TIMESTAMP_SHIFT)
                | (self._worker_id << _WORKER_SHIFT)
                | self._sequence
            )


# Lazy singleton wired via get_snowflake() in app/database.py
_snowflake: SnowflakeGenerator | None = None
_init_lock = asyncio.Lock()


async def get_snowflake() -> SnowflakeGenerator:
    """Dependency-injection helper — returns a process-wide Snowflake singleton."""
    global _snowflake
    if _snowflake is not None:
        return _snowflake
    async with _init_lock:
        if _snowflake is not None:
            return _snowflake
        worker_id = int(os.getenv("WORKER_ID", "1"))
        _snowflake = SnowflakeGenerator(worker_id=worker_id)
        return _snowflake
