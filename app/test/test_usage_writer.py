"""Tests for BufferedUsageWriter batching behavior."""
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.llm.buffered_usage_writer import (
    BufferedUsageWriter,
    get_buffered_usage_writer,
)
from app.repository.usage_repository import UsageRepository


class TestBufferedEnqueue:
    """enqueue() buffers records until flush."""

    @pytest.mark.asyncio
    async def test_enqueue_does_not_write_immediately(self, test_db):
        """Before start(), enqueue just fills the queue."""
        repo = UsageRepository()
        writer = BufferedUsageWriter(usage_repo=repo, flush_interval=60, batch_size=10)

        with patch(
            "app.services.llm.buffered_usage_writer.async_session_factory"
        ) as mock_factory:
            await writer.enqueue(
                uid=1,
                credential_id=5,
                provider="openai",
                model="gpt-4",
                prompt_tokens=100,
                completion_tokens=50,
                total_tokens=150,
                api_calls=1,
                cost_estimate=0.001,
            )
            # batch_record should not be called before flush.
            mock_factory.assert_not_called()

        assert writer.pending_count == 1
        await writer.shutdown()

    @pytest.mark.asyncio
    async def test_flush_on_batch_size(self, test_db):
        """When batch_size records are enqueued, a flush happens."""
        from sqlalchemy import select
        from app.models import CredentialUsage

        repo = UsageRepository()
        writer = BufferedUsageWriter(usage_repo=repo, flush_interval=60, batch_size=2)

        with patch(
            "app.services.llm.buffered_usage_writer.async_session_factory"
        ) as mock_factory:
            mock_ctx = AsyncMock()
            mock_ctx.__aenter__ = AsyncMock(return_value=test_db)
            mock_ctx.__aexit__ = AsyncMock(return_value=None)
            mock_factory.return_value = mock_ctx

            await writer.start()
            await writer.enqueue(uid=1, total_tokens=100)
            await writer.enqueue(uid=1, total_tokens=200)

            # Give the flush loop a moment to process.
            await asyncio.sleep(0.1)
            await writer.shutdown()

        rows = (await test_db.execute(select(CredentialUsage))).scalars().all()
        assert len(rows) == 2
        assert sum(r.total_tokens for r in rows) == 300
        assert writer.pending_count == 0

    @pytest.mark.asyncio
    async def test_flush_on_shutdown(self, test_db):
        """shutdown() drains pending records."""
        from sqlalchemy import select
        from app.models import CredentialUsage

        repo = UsageRepository()
        writer = BufferedUsageWriter(usage_repo=repo, flush_interval=60, batch_size=100)

        with patch(
            "app.services.llm.buffered_usage_writer.async_session_factory"
        ) as mock_factory:
            mock_ctx = AsyncMock()
            mock_ctx.__aenter__ = AsyncMock(return_value=test_db)
            mock_ctx.__aexit__ = AsyncMock(return_value=None)
            mock_factory.return_value = mock_ctx

            await writer.start()
            await writer.enqueue(uid=1, total_tokens=100)
            await writer.shutdown()

        rows = (await test_db.execute(select(CredentialUsage))).scalars().all()
        assert len(rows) == 1
        assert rows[0].total_tokens == 100


class TestPendingCount:
    """pending_count reflects queued + pending records."""

    @pytest.mark.asyncio
    async def test_pending_count_tracks_records(self):
        writer = BufferedUsageWriter(flush_interval=60, batch_size=100)
        await writer.enqueue(uid=1, total_tokens=100)
        await writer.enqueue(uid=1, total_tokens=200)
        assert writer.pending_count == 2
        await writer.shutdown()


class TestStartAndShutdown:
    """start/shutdown manage the background flush loop."""

    @pytest.mark.asyncio
    async def test_start_creates_flush_task(self):
        writer = BufferedUsageWriter()
        await writer.start()
        assert writer._flush_task is not None
        await writer.shutdown()
        assert writer._flush_task is None

    @pytest.mark.asyncio
    async def test_shutdown_idempotent(self):
        writer = BufferedUsageWriter()
        await writer.start()
        await writer.shutdown()
        await writer.shutdown()  # should not raise


class TestSingletonFactory:
    """Global singleton factory."""

    @pytest.mark.asyncio
    async def test_get_returns_buffered_usage_writer(self):
        writer = get_buffered_usage_writer()
        assert isinstance(writer, BufferedUsageWriter)
        await writer.shutdown()

    @pytest.mark.asyncio
    async def test_get_returns_same_instance(self):
        w1 = get_buffered_usage_writer()
        w2 = get_buffered_usage_writer()
        assert w1 is w2
        await w1.shutdown()


class TestWriteFailure:
    """Flush failures are logged but not propagated."""

    @pytest.mark.asyncio
    async def test_write_failure_does_not_crash(self):
        """DB exception during flush does not crash enqueue/start."""
        repo = MagicMock(spec=UsageRepository)
        repo.batch_record = AsyncMock(side_effect=Exception("DB unavailable"))

        writer = BufferedUsageWriter(usage_repo=repo, flush_interval=60, batch_size=1)

        with patch(
            "app.services.llm.buffered_usage_writer.async_session_factory"
        ) as mock_factory:
            mock_ctx = AsyncMock()
            mock_ctx.__aenter__ = AsyncMock(return_value=MagicMock())
            mock_ctx.__aexit__ = AsyncMock(return_value=None)
            mock_factory.return_value = mock_ctx

            await writer.start()
            # Should not raise.
            await writer.enqueue(uid=1, total_tokens=100)
            await asyncio.sleep(0.1)
            await writer.shutdown()
