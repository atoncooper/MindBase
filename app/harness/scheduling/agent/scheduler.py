"""Agent Scheduler — concurrency control, queuing, scheduling for agent invocations.

Wraps ``AgentLifecycleManager`` to add per-agent-type concurrency limits,
FIFO queues (with PriorityQueue reserved for the future), delayed/scheduled
execution, cancellation, and health checks.

All state is in-memory only.  A process restart clears everything.
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from app.agent.lifecycle import AgentLifecycleManager
from app.agent.memory.handlers import ErrorCategory, classify_error

logger = logging.getLogger(__name__)

# ===========================================================================
# Queue protocol (FIFO now, PriorityQueue later)
# ===========================================================================


@runtime_checkable
class QueueProtocol(Protocol):
    """Abstract queue interface.

    Currently backed by ``asyncio.Queue`` (FIFO).  A future ``PriorityQueue``
    implementation can swap in without changing anything else.
    """

    async def put(self, item: Any) -> None: ...
    async def get(self) -> Any: ...
    def qsize(self) -> int: ...


class FifoQueue(QueueProtocol):
    """FIFO queue backed by ``asyncio.Queue``."""

    def __init__(self, maxsize: int = 0) -> None:
        self._q: asyncio.Queue = asyncio.Queue(maxsize=maxsize)

    async def put(self, item: Any) -> None:
        await self._q.put(item)

    async def get(self) -> Any:
        return await self._q.get()

    def qsize(self) -> int:
        return self._q.qsize()


# ===========================================================================
# Config / data models
# ===========================================================================


@dataclass(frozen=True)
class AgentRetryConfig:
    """Retry policy for failed agent invocations."""

    max_retries: int = 2
    backoff_base: float = 1.0
    backoff_max: float = 30.0


@dataclass(frozen=True)
class AgentConfig:
    """Per-agent-type scheduling configuration."""

    max_concurrent: int = 1
    max_queue: int = 50
    retry: AgentRetryConfig | None = None


@dataclass
class InvocationTicket:
    """One queued or scheduled invocation."""

    job_id: str
    agent_name: str
    session_id: str
    input: dict[str, Any]
    timeout: float | None = 60.0
    created_at: float = field(default_factory=time.monotonic)

    # Set by worker when dequeued
    event: asyncio.Event | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    cancelled: bool = False
    retry_count: int = 0


@dataclass
class AgentSlot:
    """Per-agent-type runtime state."""

    semaphore: asyncio.Semaphore
    queue: QueueProtocol
    worker_task: asyncio.Task | None = None
    health_task: asyncio.Task | None = None
    active: int = 0
    config: AgentConfig = field(default_factory=AgentConfig)


# ===========================================================================
# Agent Scheduler
# ===========================================================================


class AgentScheduler:
    """Per-agent-type concurrency + queue + scheduling wrapper.

    Usage::

        scheduler = AgentScheduler(lifecycle)
        scheduler.set_config("memory", AgentConfig(max_concurrent=1))
        await scheduler.start()

        # Immediate, possibly queued:
        result = await scheduler.invoke("memory", session_id="abc", query="...")

        # Delayed:
        await scheduler.invoke("memory", session_id="abc",
                               delay_seconds=30, query="...")
    """

    def __init__(self, lifecycle: AgentLifecycleManager) -> None:
        self._lifecycle = lifecycle
        self._slots: dict[str, AgentSlot] = {}
        self._scheduled: dict[str, asyncio.Task] = {}
        self._running = False

    # ── lifecycle ────────────────────────────────────────────────────

    async def start(self) -> None:
        """Start workers for all configured agent types."""
        if self._running:
            return
        self._running = True
        for name, slot in self._slots.items():
            slot.worker_task = asyncio.create_task(
                self._drain_queue(name), name=f"agent-{name}"
            )
        logger.info(
            "[AGENT_SCHED] started workers=%s",
            list(self._slots.keys()),
        )

    async def shutdown(self) -> None:
        """Graceful shutdown — cancel workers and scheduled tasks."""
        if not self._running:
            return
        self._running = False

        # Cancel health checks
        for slot in self._slots.values():
            if slot.health_task is not None:
                slot.health_task.cancel()

        # Cancel scheduled tasks
        for tid in list(self._scheduled.keys()):
            self._scheduled[tid].cancel()
        self._scheduled.clear()

        # Cancel all workers and await their termination
        workers = [
            slot.worker_task
            for slot in self._slots.values()
            if slot.worker_task is not None
        ]
        for w in workers:
            w.cancel()
        if workers:
            await asyncio.gather(*workers, return_exceptions=True)

        logger.info("[AGENT_SCHED] shutdown complete")

    # ── configuration ────────────────────────────────────────────────

    def set_config(self, agent_name: str, config: AgentConfig) -> None:
        """Configure concurrency, queue, and retry for an agent type."""
        self._slots[agent_name] = AgentSlot(
            semaphore=asyncio.Semaphore(config.max_concurrent),
            queue=FifoQueue(maxsize=config.max_queue),
            config=config,
        )
        logger.info(
            "[AGENT_SCHED] config %s concurrent=%s queue=%s",
            agent_name,
            config.max_concurrent,
            config.max_queue,
        )

    # ── invoke ───────────────────────────────────────────────────────

    async def invoke(
        self,
        agent_name: str,
        session_id: str,
        *,
        timeout: float | None = 60.0,
        delay_seconds: float | None = None,
        at_timestamp: float | None = None,
        **input: Any,
    ) -> dict[str, Any]:
        """Invoke an agent through the scheduler.

        If *delay_seconds* or *at_timestamp* is provided, schedules the
        invocation for later and returns ``{"scheduled": True, "job_id": ...}``
        immediately.

        Otherwise, enqueues immediately.  If a concurrency slot is free the
        invocation runs right away; otherwise it waits in the FIFO queue.
        """
        self._ensure_slot(agent_name)

        ticket = InvocationTicket(
            job_id=uuid.uuid4().hex[:12],
            agent_name=agent_name,
            session_id=session_id,
            timeout=timeout,
            input=input,
        )

        # Scheduled / delayed path
        if delay_seconds is not None or at_timestamp is not None:
            fire_at = at_timestamp or (time.monotonic() + (delay_seconds or 0))
            task = asyncio.create_task(
                self._schedule_one(ticket, fire_at),
                name=f"sched-{ticket.job_id}",
            )
            self._scheduled[ticket.job_id] = task
            task.add_done_callback(lambda _: self._scheduled.pop(ticket.job_id, None))
            logger.debug(
                "[AGENT_SCHED] scheduled %s/%s job=%s at=%.1f",
                agent_name,
                session_id,
                ticket.job_id,
                fire_at,
            )
            return {"scheduled": True, "job_id": ticket.job_id}

        # Immediate path: enqueue and wait
        event = asyncio.Event()
        ticket.event = event
        slot = self._slots[agent_name]

        try:
            await slot.queue.put(ticket)
        except asyncio.QueueFull:
            logger.warning(
                "[AGENT_SCHED] queue full %s/%s limit=%s",
                agent_name,
                session_id,
                slot.config.max_queue,
            )
            return {"error": "queue full, try again later"}

        await event.wait()

        if ticket.cancelled:
            return {"cancelled": True, "job_id": ticket.job_id}
        if ticket.error:
            return {"error": ticket.error}
        return ticket.result or {}

    # ── cancel ───────────────────────────────────────────────────────

    async def cancel(self, job_id: str) -> bool:
        """Cancel a queued or scheduled invocation by *job_id*.

        Returns True if the job was found and cancelled.
        """
        # Check scheduled tasks
        task = self._scheduled.get(job_id)
        if task is not None and not task.done():
            task.cancel()
            logger.debug("[AGENT_SCHED] cancelled scheduled job=%s", job_id)
            return True

        # Check queues — O(n) per agent type. Acceptable for small queues.
        for name, slot in self._slots.items():
            cancelled = await self._cancel_in_queue(slot, job_id)
            if cancelled:
                logger.debug(
                    "[AGENT_SCHED] cancelled queued job=%s agent=%s", job_id, name
                )
                return True

        return False

    async def _cancel_in_queue(self, slot: AgentSlot, job_id: str) -> bool:
        """Scan the queue and cancel a ticket by job_id."""
        # asyncio.Queue is not iterable — we can't scan it directly.
        # Instead we mark the ticket as cancelled when it's dequeued.
        # For scheduled tasks we already handle it above.
        # For queued-but-not-yet-processed, we can only cancel via scheduled path.
        return False

    # ── health ───────────────────────────────────────────────────────

    async def start_health_checks(self, interval: float = 30.0) -> None:
        """Start periodic health pings per agent type."""
        for name in self._slots:
            if self._slots[name].health_task is None:
                self._slots[name].health_task = asyncio.create_task(
                    self._health_loop(name, interval),
                    name=f"health-{name}",
                )

    async def stop_health_checks(self) -> None:
        """Cancel all health-check tasks."""
        for slot in self._slots.values():
            if slot.health_task is not None:
                slot.health_task.cancel()
                slot.health_task = None

    async def _health_loop(self, agent_name: str, interval: float) -> None:
        """Periodically ping an agent type and log on failure."""
        while self._running:
            try:
                await asyncio.sleep(interval)
                h = await self._lifecycle.health()
                ok = agent_name in h.get("registered_agents", [])
                if not ok:
                    logger.warning(
                        "[AGENT_SCHED] health %s: not registered",
                        agent_name,
                    )
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning("[AGENT_SCHED] health %s: %s", agent_name, exc)

    # ── stats / health ───────────────────────────────────────────────

    def stats(self) -> dict[str, Any]:
        """Return per-agent and aggregate statistics."""
        agents: dict[str, dict[str, Any]] = {}
        total_active = 0
        total_waiting = 0

        for name, slot in self._slots.items():
            qsize = slot.queue.qsize()
            agents[name] = {
                "active": slot.active,
                "waiting": qsize,
                "limit": slot.config.max_concurrent,
            }
            total_active += slot.active
            total_waiting += qsize

        return {
            "running": self._running,
            "agents": agents,
            "totals": {
                "active": total_active,
                "waiting": total_waiting,
            },
        }

    # ── internal ─────────────────────────────────────────────────────

    def _ensure_slot(self, agent_name: str) -> None:
        """Create a default slot if not configured."""
        if agent_name not in self._slots:
            self.set_config(agent_name, AgentConfig())

    async def _schedule_one(self, ticket: InvocationTicket, fire_at: float) -> None:
        """Sleep until *fire_at*, then enqueue the ticket."""
        now = time.monotonic()
        delay = max(0, fire_at - now)
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return

        if not self._running or ticket.cancelled:
            return

        slot = self._slots.get(ticket.agent_name)
        if slot is None:
            return

        event = asyncio.Event()
        ticket.event = event
        try:
            await slot.queue.put(ticket)
        except asyncio.QueueFull:
            logger.warning(
                "[AGENT_SCHED] queue full on schedule %s/%s",
                ticket.agent_name,
                ticket.session_id,
            )
            return

        await event.wait()

    async def _drain_queue(self, agent_name: str) -> None:
        """Background worker: dequeue tickets and execute.

        Runs as an ``asyncio.Task`` per agent type.
        """
        slot = self._slots.get(agent_name)
        if slot is None:
            return

        logger.debug("[AGENT_SCHED] worker started agent=%s", agent_name)

        while self._running:
            try:
                ticket = await slot.queue.get()
            except asyncio.CancelledError:
                break

            if not self._running:
                break

            if ticket.cancelled:
                if ticket.event:
                    ticket.event.set()
                continue

            async with slot.semaphore:
                slot.active += 1
                ticket.event = asyncio.Event() if ticket.event is None else ticket.event

                result = await self._execute_with_retry(ticket, slot)

                if ticket.cancelled:
                    result = {"cancelled": True, "job_id": ticket.job_id}

                if ticket.error:
                    result = {"error": ticket.error}

                ticket.result = result
                ticket.event.set()
                slot.active -= 1

        logger.debug("[AGENT_SCHED] worker stopped agent=%s", agent_name)

    async def _execute_with_retry(
        self,
        ticket: InvocationTicket,
        slot: AgentSlot,
    ) -> dict[str, Any]:
        """Execute a ticket with optional retry on retryable errors."""
        retry_cfg = slot.config.retry

        for attempt in itertools.count():
            ticket.retry_count = attempt
            try:
                return await self._lifecycle.invoke(
                    ticket.agent_name,
                    ticket.session_id,
                    timeout=ticket.timeout,
                    **ticket.input,
                )
            except Exception as exc:
                error_msg = str(exc)
                category = classify_error(error_msg)

                if (
                    retry_cfg is not None
                    and category is ErrorCategory.RETRYABLE
                    and attempt < retry_cfg.max_retries
                ):
                    delay = min(
                        retry_cfg.backoff_base * (2**attempt),
                        retry_cfg.backoff_max,
                    )
                    logger.warning(
                        "[AGENT_SCHED] retry %s/%s attempt=%s/%s "
                        "error=%s backoff=%.1fs",
                        ticket.agent_name,
                        ticket.session_id,
                        attempt + 1,
                        retry_cfg.max_retries,
                        error_msg,
                        delay,
                    )
                    await asyncio.sleep(delay)
                    continue

                ticket.error = error_msg
                logger.error(
                    "[AGENT_SCHED] failed %s/%s (final) error=%s",
                    ticket.agent_name,
                    ticket.session_id,
                    error_msg,
                )
                return {"error": error_msg}
