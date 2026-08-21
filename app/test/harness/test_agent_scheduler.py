"""Unit tests for AgentScheduler - cancel semantics and cancellation safety.

Covers two HIGH-severity behaviours that were previously broken:

1. ``cancel(job_id)`` now actually cancels queued / scheduled jobs (the old
   ``_cancel_in_queue`` always returned False and ``ticket.cancelled`` was
   never set anywhere).
2. A worker task cancelled mid-execution must still set the ticket event
   (so the ``invoke()`` caller does not hang forever) and decrement
   ``slot.active`` (so the slot count does not leak).

All tests use a fake lifecycle to avoid real agent / LLM / DB dependencies.
"""

from __future__ import annotations

import asyncio

import pytest

from app.harness.scheduling.agent.scheduler import (
    AgentConfig,
    AgentRetryConfig,
    AgentScheduler,
    InvocationTicket,
    TicketState,
)


# ---------------------------------------------------------------------------
# Fake lifecycle - controllable invoke timing
# ---------------------------------------------------------------------------


class _FakeLifecycle:
    """Stand-in for ``AgentLifecycleManager`` with a gate on ``invoke``.

    ``invoke`` blocks until ``gate`` is set, so tests can occupy the single
    concurrency slot and queue / cancel work behind it.
    """

    def __init__(self) -> None:
        self.gate = asyncio.Event()
        self.started = asyncio.Event()
        self.invoke_count = 0

    async def invoke(self, agent_name, session_id, *, timeout=None, **input):
        self.started.set()
        await self.gate.wait()  # block until the test releases us
        self.invoke_count += 1
        return {"result": f"{agent_name}:{session_id}"}

    async def health(self):
        return {"registered_agents": ["chat"]}


async def _drain() -> None:
    """Yield control to let queued tasks / workers make progress."""
    await asyncio.sleep(0)


# ---------------------------------------------------------------------------
# cancel() - unknown / running
# ---------------------------------------------------------------------------


class TestCancelUnknown:
    @pytest.mark.asyncio
    async def test_cancel_unknown_job_returns_false(self) -> None:
        sched = AgentScheduler(_FakeLifecycle())
        await sched.start()
        try:
            assert await sched.cancel("does-not-exist") is False
        finally:
            await sched.shutdown()


class TestCancelRunning:
    @pytest.mark.asyncio
    async def test_cancel_running_job_returns_false(self) -> None:
        lc = _FakeLifecycle()
        sched = AgentScheduler(lc)
        sched.set_config("chat", AgentConfig(max_concurrent=1))
        await sched.start()
        try:
            t1 = asyncio.create_task(
                sched.invoke("chat", session_id="s1", query="q")
            )
            await lc.started.wait()  # worker is inside lifecycle.invoke

            running = [
                t for t in sched._tickets.values() if t.session_id == "s1"
            ]
            assert len(running) == 1
            assert running[0].state == TicketState.RUNNING

            assert await sched.cancel(running[0].job_id) is False

            lc.gate.set()
            await asyncio.wait_for(t1, timeout=2)
        finally:
            await sched.shutdown()


# ---------------------------------------------------------------------------
# cancel() - queued job (occupies slot, cancel the waiting one)
# ---------------------------------------------------------------------------


class TestCancelQueued:
    @pytest.mark.asyncio
    async def test_cancel_queued_job_skips_execution(self) -> None:
        lc = _FakeLifecycle()
        sched = AgentScheduler(lc)
        sched.set_config("chat", AgentConfig(max_concurrent=1))
        await sched.start()
        try:
            # t1 occupies the only slot (gate closed).
            t1 = asyncio.create_task(
                sched.invoke("chat", session_id="s1", query="q1")
            )
            await lc.started.wait()

            # t2 queues behind it.
            t2 = asyncio.create_task(
                sched.invoke("chat", session_id="s2", query="q2")
            )
            await _drain()

            queued = [
                t for t in sched._tickets.values() if t.session_id == "s2"
            ]
            assert len(queued) == 1
            assert queued[0].state == TicketState.QUEUED

            ok = await sched.cancel(queued[0].job_id)
            assert ok is True

            # t2 must return promptly with a cancelled payload, no hang.
            r2 = await asyncio.wait_for(t2, timeout=2)
            assert r2 == {"cancelled": True, "job_id": queued[0].job_id}

            # Release t1 and confirm only s1 executed.
            lc.gate.set()
            r1 = await asyncio.wait_for(t1, timeout=2)
            assert r1 == {"result": "chat:s1"}
            assert lc.invoke_count == 1
        finally:
            await sched.shutdown()


# ---------------------------------------------------------------------------
# cancel() - scheduled (delayed) job, before it fires
# ---------------------------------------------------------------------------


class TestCancelScheduled:
    @pytest.mark.asyncio
    async def test_cancel_scheduled_before_fire(self) -> None:
        lc = _FakeLifecycle()
        sched = AgentScheduler(lc)
        sched.set_config("chat", AgentConfig(max_concurrent=1))
        await sched.start()
        try:
            res = await sched.invoke(
                "chat", session_id="s1", delay_seconds=10, query="q"
            )
            assert res["scheduled"] is True
            job_id = res["job_id"]

            ok = await sched.cancel(job_id)
            assert ok is True
            await _drain()
            assert lc.invoke_count == 0  # never fired
        finally:
            await sched.shutdown()

    @pytest.mark.asyncio
    async def test_cancel_scheduled_after_fired_into_queue(self) -> None:
        """A scheduled job that has already fired into a full queue can
        still be cancelled before the worker picks it up."""
        lc = _FakeLifecycle()
        sched = AgentScheduler(lc)
        sched.set_config("chat", AgentConfig(max_concurrent=1))
        await sched.start()
        try:
            # Occupy the slot.
            t1 = asyncio.create_task(
                sched.invoke("chat", session_id="s1", query="q1")
            )
            await lc.started.wait()

            res = await sched.invoke(
                "chat", session_id="s2", delay_seconds=0.05, query="q2"
            )
            job_id = res["job_id"]
            await asyncio.sleep(0.15)  # let the delay elapse -> enqueued

            ok = await sched.cancel(job_id)
            assert ok is True

            lc.gate.set()
            await asyncio.wait_for(t1, timeout=2)
            assert lc.invoke_count == 1  # s2 cancelled, never ran
        finally:
            await sched.shutdown()


# ---------------------------------------------------------------------------
# Worker cancellation safety (HIGH #2)
# ---------------------------------------------------------------------------


class TestWorkerCancellation:
    @pytest.mark.asyncio
    async def test_worker_cancel_unblocks_caller_and_releases_slot(self) -> None:
        lc = _FakeLifecycle()
        sched = AgentScheduler(lc)
        sched.set_config("chat", AgentConfig(max_concurrent=1))
        await sched.start()
        try:
            t1 = asyncio.create_task(
                sched.invoke("chat", session_id="s1", query="q")
            )
            await lc.started.wait()  # worker is inside _execute_with_retry

            assert sched._slots["chat"].active == 1

            worker = sched._slots["chat"].worker_task
            worker.cancel()  # simulate shutdown / external cancellation

            # Caller must NOT hang - event must be set in finally.
            await asyncio.wait_for(t1, timeout=2)

            # Slot count must not leak.
            assert sched._slots["chat"].active == 0
        finally:
            await sched.shutdown()


# ---------------------------------------------------------------------------
# InvocationTicket state contract
# ---------------------------------------------------------------------------


class TestTicketState:
    def test_initial_state_is_queued(self) -> None:
        ticket = InvocationTicket(
            job_id="abc",
            agent_name="chat",
            session_id="s1",
            input={},
        )
        assert ticket.state == TicketState.QUEUED
        assert ticket.cancelled is False


# ---------------------------------------------------------------------------
# _execute_with_retry - retry classification (lazy import path exercised)
# ---------------------------------------------------------------------------


class _FlakyLifecycle:
    """Lifecycle that raises *fail_times* times then succeeds."""

    def __init__(self, error_factory, fail_times: int = 0) -> None:
        self.error_factory = error_factory
        self.fail_times = fail_times
        self.calls = 0

    async def invoke(self, agent_name, session_id, *, timeout=None, **input):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise self.error_factory()
        return {"result": "ok"}

    async def health(self):
        return {"registered_agents": ["chat"]}


def _retry_cfg() -> AgentRetryConfig:
    return AgentRetryConfig(max_retries=2, backoff_base=0.01, backoff_max=0.05)


class TestExecuteWithRetry:
    @pytest.mark.asyncio
    async def test_retryable_error_retries_then_succeeds(self) -> None:
        lc = _FlakyLifecycle(lambda: RuntimeError("connection timeout"), fail_times=1)
        sched = AgentScheduler(lc)
        sched.set_config(
            "chat", AgentConfig(max_concurrent=1, retry=_retry_cfg())
        )
        await sched.start()
        try:
            result = await asyncio.wait_for(
                sched.invoke("chat", session_id="s1", query="q"), timeout=5
            )
            assert result == {"result": "ok"}
            assert lc.calls == 2
        finally:
            await sched.shutdown()

    @pytest.mark.asyncio
    async def test_non_retryable_error_does_not_retry(self) -> None:
        lc = _FlakyLifecycle(lambda: RuntimeError("unknown glitch"), fail_times=99)
        sched = AgentScheduler(lc)
        sched.set_config(
            "chat", AgentConfig(max_concurrent=1, retry=_retry_cfg())
        )
        await sched.start()
        try:
            result = await asyncio.wait_for(
                sched.invoke("chat", session_id="s1", query="q"), timeout=5
            )
            assert "error" in result
            assert lc.calls == 1
        finally:
            await sched.shutdown()

    @pytest.mark.asyncio
    async def test_fatal_error_does_not_retry(self) -> None:
        lc = _FlakyLifecycle(lambda: RuntimeError("invalid api key"), fail_times=99)
        sched = AgentScheduler(lc)
        sched.set_config(
            "chat", AgentConfig(max_concurrent=1, retry=_retry_cfg())
        )
        await sched.start()
        try:
            result = await asyncio.wait_for(
                sched.invoke("chat", session_id="s1", query="q"), timeout=5
            )
            assert "error" in result
            assert lc.calls == 1
        finally:
            await sched.shutdown()

    @pytest.mark.asyncio
    async def test_retry_exhausted_returns_error(self) -> None:
        lc = _FlakyLifecycle(lambda: RuntimeError("connection timeout"), fail_times=99)
        sched = AgentScheduler(lc)
        sched.set_config(
            "chat", AgentConfig(max_concurrent=1, retry=_retry_cfg())
        )
        await sched.start()
        try:
            result = await asyncio.wait_for(
                sched.invoke("chat", session_id="s1", query="q"), timeout=5
            )
            assert "error" in result
            assert lc.calls == 3  # 1 initial + 2 retries
        finally:
            await sched.shutdown()
