"""Buffered usage writer — batches LLM usage records and flushes to DB.

Design:
- enqueue() puts records into an asyncio.Queue and returns immediately.
- A background flush_loop drains the queue and writes batches.
- Flush triggers on:
  - batch_size records accumulated (default 50)
  - flush_interval seconds elapsed (default 30)
  - shutdown() called
- shutdown() drains the queue with asyncio.shield to reduce data loss on
  Ctrl+C / process termination.
"""
from __future__ import annotations

import asyncio
import time
from typing import Optional

from loguru import logger

from app.database import async_session_factory
from app.repository.usage_repository import UsageRepository, get_usage_repository


class BufferedUsageWriter:
    """Background buffered writer for credential_usage records."""

    def __init__(
        self,
        usage_repo: Optional[UsageRepository] = None,
        flush_interval: float = 30.0,
        batch_size: int = 50,
    ) -> None:
        self._repo = usage_repo or get_usage_repository()
        self._flush_interval = flush_interval
        self._batch_size = max(1, batch_size)

        self._queue: asyncio.Queue[dict] = asyncio.Queue()
        self._flush_task: Optional[asyncio.Task] = None
        self._shutdown_event = asyncio.Event()
        self._pending: list[dict] = []
        self._last_flush = time.monotonic()
        self._started = False
        self._closed = False

    async def start(self) -> None:
        """Start the background flush loop."""
        if self._started:
            return
        self._started = True
        self._closed = False
        self._flush_task = asyncio.create_task(self._flush_loop())
        logger.info(
            "[USAGE_WRITER] buffered writer started "
            f"(interval={self._flush_interval}s, batch_size={self._batch_size})"
        )

    async def enqueue(self, **record: object) -> None:
        """Enqueue a usage record for batch writing.

        Non-blocking. Records are dictionaries matching CredentialUsage columns.
        """
        if self._closed:
            logger.warning("[USAGE_WRITER] enqueue called after shutdown; dropping record")
            return
        await self._queue.put(record)
        logger.debug(
            f"[USAGE_WRITER] enqueued record tokens={record.get('total_tokens', 0)} "
            f"provider={record.get('provider', '?')}"
        )

    async def shutdown(self) -> None:
        """Graceful shutdown: drain the queue and write remaining records."""
        if not self._started or self._closed:
            return
        self._closed = True
        self._shutdown_event.set()

        if self._flush_task is not None:
            try:
                await asyncio.shield(self._flush_task)
            except asyncio.CancelledError:
                pass
            self._flush_task = None

        # Final drain after the loop exits.
        await self._drain_and_flush()
        self._started = False
        logger.info("[USAGE_WRITER] shutdown complete")

    @property
    def pending_count(self) -> int:
        """Number of records currently buffered (in queue + pending list)."""
        return self._queue.qsize() + len(self._pending)

    async def _flush_loop(self) -> None:
        """Background loop that flushes records periodically or by batch size."""
        try:
            while not self._shutdown_event.is_set():
                # Wait for a record, but wake up every second to check shutdown.
                # This keeps shutdown latency low even when flush_interval is large.
                try:
                    record = await asyncio.wait_for(
                        self._queue.get(), timeout=1.0
                    )
                    self._pending.append(record)
                except asyncio.TimeoutError:
                    pass

                # Pull any additional records already in the queue without waiting.
                while not self._queue.empty() and len(self._pending) < self._batch_size:
                    try:
                        self._pending.append(self._queue.get_nowait())
                    except asyncio.QueueEmpty:
                        break

                if self._pending and (
                    len(self._pending) >= self._batch_size
                    or time.monotonic() - self._last_flush >= self._flush_interval
                    or self._shutdown_event.is_set()
                ):
                    await self._flush()
        except asyncio.CancelledError:
            logger.debug("[USAGE_WRITER] flush loop cancelled")
            raise
        except Exception:
            logger.exception("[USAGE_WRITER] flush loop died")

    async def _drain_and_flush(self) -> None:
        """Drain remaining queue items and flush them."""
        while not self._queue.empty():
            try:
                self._pending.append(self._queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        if self._pending:
            await self._flush()

    async def _flush(self) -> None:
        """Write the pending batch to the database."""
        if not self._pending:
            return

        batch = self._pending
        self._pending = []
        self._last_flush = time.monotonic()

        start = time.monotonic()
        try:
            async with async_session_factory() as db:
                await self._repo.batch_record(batch, db)
            elapsed_ms = (time.monotonic() - start) * 1000
            total_tokens = sum(r.get("total_tokens", 0) for r in batch)
            logger.info(
                f"[USAGE_WRITER] flushed {len(batch)} records "
                f"({total_tokens} tokens) in {elapsed_ms:.0f}ms"
            )
        except Exception as e:
            logger.error(f"[USAGE_WRITER] flush failed for {len(batch)} records: {e}")
            # Re-queue is risky if the failure is persistent; drop and log instead.
            # Operators should monitor error logs and alert on flush failures.


# Module-level singleton
_writer: Optional[BufferedUsageWriter] = None


def get_buffered_usage_writer() -> BufferedUsageWriter:
    """Return the global BufferedUsageWriter singleton."""
    global _writer
    if _writer is None:
        _writer = BufferedUsageWriter()
    return _writer


async def start_buffered_usage_writer() -> BufferedUsageWriter:
    """Start the global writer singleton (called in lifespan startup)."""
    writer = get_buffered_usage_writer()
    await writer.start()
    return writer


async def shutdown_buffered_usage_writer() -> None:
    """Shut down the global writer singleton (called in lifespan shutdown)."""
    global _writer
    if _writer is not None:
        await _writer.shutdown()
        _writer = None
