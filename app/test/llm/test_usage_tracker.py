"""Tests for ``UsageTrackingCallback`` cross-thread loop scheduling fix.

Pins the regression where sync ``on_llm_end`` (invoked by LangChain from an
executor worker thread — e.g. ``asyncio_0``) called ``asyncio.ensure_future``
and crashed with ``RuntimeError: no current event loop``. The fix:

  1. Capture the running loop at construction (``__init__``).
  2. In ``on_llm_end``, schedule the coroutine back onto the captured loop via
     ``asyncio.run_coroutine_threadsafe(coro, loop)``.
  3. Fall back to a warning log when no writer or no loop is available.

Covers:
- Loop capture in ``__init__`` (success + RuntimeError fallback)
- ``run_coroutine_threadsafe`` is used when loop + writer present
- Warning path when no writer
- Warning path when no loop (e.g. constructed outside a running loop)
- ``total_tokens == 0`` still records the API call (api_calls=1)
- Token extraction from both ``llm_output`` (non-streaming) and
  ``usage_metadata`` (streaming) paths
- cost_estimate is computed and passed to the writer
- Exception isolation: ``on_llm_end`` never re-raises
- End-to-end cross-thread scheduling reproducing the original bug scenario
"""

from __future__ import annotations

import asyncio
import sys
import threading
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from langchain_core.messages import AIMessage  # noqa: E402
from langchain_core.outputs import ChatGeneration, LLMResult  # noqa: E402

from app.services.llm.usage_tracker import (  # noqa: E402
    UsageTrackingCallback,
    _extract_token_usage,
)


# ─── helpers ────────────────────────────────────────────────────────


def _make_llm_result(
    prompt_tokens: int, completion_tokens: int, total_tokens: int
) -> LLMResult:
    """Build a non-streaming LLMResult (token_usage in llm_output)."""
    return LLMResult(
        generations=[[]],
        llm_output={
            "token_usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": total_tokens,
            }
        },
    )


def _make_llm_result_streaming(
    input_tokens: int, output_tokens: int, total_tokens: int = 0
) -> LLMResult:
    """Build a streaming LLMResult (usage_metadata on message, llm_output=None)."""
    tt = total_tokens or input_tokens + output_tokens
    msg = AIMessage(
        content="test response",
        usage_metadata={
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": tt,
        },
    )
    gen = ChatGeneration(message=msg)
    return LLMResult(generations=[[gen]], llm_output=None)


def _make_llm_result_no_usage() -> LLMResult:
    return LLMResult(generations=[[]], llm_output={"some_other_key": "value"})


def _make_llm_result_null_output() -> LLMResult:
    return LLMResult(generations=[[]], llm_output=None)


class _FakeWriter:
    """Async mock writer with ``enqueue``."""

    def __init__(self) -> None:
        self.enqueue = AsyncMock()


# ═══════════════════════════════════════════════════════════════
# _extract_token_usage 单元测试
# ═══════════════════════════════════════════════════════════════


class TestExtractTokenUsage:
    """``_extract_token_usage`` 兼容流式与非流式两种路径。"""

    def test_llm_output_path(self) -> None:
        """Non-streaming: prefer llm_output.token_usage."""
        response = _make_llm_result(100, 50, 150)
        p, c, t, src = _extract_token_usage(response)
        assert (p, c, t, src) == (100, 50, 150, "llm_output")

    def test_usage_metadata_path(self) -> None:
        """Streaming: fall back to usage_metadata when llm_output is None."""
        response = _make_llm_result_streaming(200, 80, 280)
        p, c, t, src = _extract_token_usage(response)
        assert (p, c, t, src) == (200, 80, 280, "usage_metadata")

    def test_usage_metadata_total_from_parts(self) -> None:
        """Streaming: total_tokens=0 → derive from input+output."""
        response = _make_llm_result_streaming(50, 30, 0)
        p, c, t, src = _extract_token_usage(response)
        assert (p, c, t, src) == (50, 30, 80, "usage_metadata")

    def test_llm_output_priority(self) -> None:
        """Both present → llm_output wins."""
        msg = AIMessage(
            content="test",
            usage_metadata={
                "input_tokens": 999,
                "output_tokens": 999,
                "total_tokens": 1998,
            },
        )
        gen = ChatGeneration(message=msg)
        response = LLMResult(
            generations=[[gen]],
            llm_output={
                "token_usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 20,
                    "total_tokens": 30,
                }
            },
        )
        p, c, t, src = _extract_token_usage(response)
        assert (p, c, t, src) == (10, 20, 30, "llm_output")

    def test_both_empty(self) -> None:
        response = LLMResult(generations=[[]], llm_output=None)
        p, c, t, src = _extract_token_usage(response)
        assert (p, c, t, src) == (0, 0, 0, "none")

    def test_usage_metadata_zero_tokens(self) -> None:
        msg = AIMessage(
            content="test",
            usage_metadata={"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
        )
        gen = ChatGeneration(message=msg)
        response = LLMResult(generations=[[gen]], llm_output=None)
        p, c, t, src = _extract_token_usage(response)
        assert (p, c, t, src) == (0, 0, 0, "none")

    def test_no_usage_metadata_attr(self) -> None:
        msg = AIMessage(content="test")
        gen = ChatGeneration(message=msg)
        response = LLMResult(generations=[[gen]], llm_output=None)
        p, c, t, src = _extract_token_usage(response)
        assert (p, c, t, src) == (0, 0, 0, "none")

    def test_llm_output_token_usage_is_none(self) -> None:
        """llm_output present but token_usage=None → fall back to usage_metadata."""
        msg = AIMessage(
            content="test",
            usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
        )
        gen = ChatGeneration(message=msg)
        response = LLMResult(
            generations=[[gen]],
            llm_output={"token_usage": None},
        )
        p, c, t, src = _extract_token_usage(response)
        assert (p, c, t, src) == (10, 5, 15, "usage_metadata")


# ═══════════════════════════════════════════════════════════════
# UsageTrackingCallback.__init__ loop capture
# ═══════════════════════════════════════════════════════════════


class TestLoopCapture:
    """``__init__`` captures the running loop or falls back to None."""

    def test_init_captures_running_loop(self) -> None:
        async def _run() -> None:
            cb = UsageTrackingCallback(uid=1)
            assert cb._loop is asyncio.get_running_loop()

        asyncio.run(_run())

    def test_init_without_running_loop_sets_none(self) -> None:
        """Constructed from a plain sync context (no running loop)."""
        cb = UsageTrackingCallback(uid=1)
        assert cb._loop is None

    def test_init_defaults(self) -> None:
        """Constructor defaults match the new uid-based signature."""
        cb = UsageTrackingCallback(uid=7)
        assert cb.uid == 7
        assert cb.credential_id is None
        assert cb.provider == "openai"
        assert cb.model is None
        assert cb._writer is None


# ═══════════════════════════════════════════════════════════════
# on_llm_end scheduling
# ═══════════════════════════════════════════════════════════════


class TestOnLlmEndScheduling:
    """``on_llm_end`` schedules enqueue via ``run_coroutine_threadsafe``."""

    @pytest.mark.asyncio
    async def test_enqueues_via_run_coroutine_threadsafe(self) -> None:
        """When loop + writer are present, schedule cross-thread."""
        writer = _FakeWriter()
        cb = UsageTrackingCallback(
            uid=42,
            credential_id=7,
            provider="openai",
            model="gpt-4o",
            writer=writer,  # type: ignore[arg-type]
        )
        result = _make_llm_result(100, 200, 300)

        with patch(
            "app.services.llm.usage_tracker.asyncio.run_coroutine_threadsafe"
        ) as mock_sched:
            cb.on_llm_end(result)

        assert mock_sched.called
        args, _ = mock_sched.call_args
        # Second positional arg must be the captured loop
        assert args[1] is cb._loop

    @pytest.mark.asyncio
    async def test_no_writer_logs_warning_and_skips_scheduling(self) -> None:
        cb = UsageTrackingCallback(uid=1, writer=None)
        result = _make_llm_result(1, 1, 2)

        with patch(
            "app.services.llm.usage_tracker.asyncio.run_coroutine_threadsafe"
        ) as mock_sched:
            cb.on_llm_end(result)

        assert not mock_sched.called

    def test_no_loop_logs_warning_and_skips_scheduling(self) -> None:
        """Constructed outside a loop → _loop is None → skip + warn."""
        cb = UsageTrackingCallback(uid=1, writer=_FakeWriter())  # type: ignore[arg-type]
        assert cb._loop is None

        result = _make_llm_result(1, 1, 2)

        with patch(
            "app.services.llm.usage_tracker.asyncio.run_coroutine_threadsafe"
        ) as mock_sched:
            cb.on_llm_end(result)

        assert not mock_sched.called

    @pytest.mark.asyncio
    async def test_zero_total_tokens_records_call(self) -> None:
        """When token usage is missing, we still record the API call itself."""
        writer = _FakeWriter()
        cb = UsageTrackingCallback(uid=1, writer=writer)  # type: ignore[arg-type]
        result = _make_llm_result(0, 0, 0)

        with patch(
            "app.services.llm.usage_tracker.asyncio.run_coroutine_threadsafe"
        ) as mock_sched:
            cb.on_llm_end(result)

        assert mock_sched.called
        args, _ = mock_sched.call_args
        coro = args[0]
        # Inspect the coroutine's bound arguments via a hack: await it and
        # inspect the writer call.  The coroutine is writer.enqueue(**record).
        await coro
        call_kwargs = writer.enqueue.await_args.kwargs
        assert call_kwargs["total_tokens"] == 0
        assert call_kwargs["api_calls"] == 1

    @pytest.mark.asyncio
    async def test_streaming_result_enqueues(self) -> None:
        """Streaming LLMResult (usage_metadata path) also enqueues."""
        writer = _FakeWriter()
        cb = UsageTrackingCallback(
            uid=99,
            provider="openai",
            model="gpt-4o",
            writer=writer,  # type: ignore[arg-type]
        )
        result = _make_llm_result_streaming(200, 80, 280)

        with patch(
            "app.services.llm.usage_tracker.asyncio.run_coroutine_threadsafe"
        ) as mock_sched:
            cb.on_llm_end(result)

        assert mock_sched.called

    @pytest.mark.asyncio
    async def test_no_token_usage_key_records_call(self) -> None:
        """When no usage metadata is returned, we still record the API call."""
        writer = _FakeWriter()
        cb = UsageTrackingCallback(uid=1, writer=writer)  # type: ignore[arg-type]
        result = _make_llm_result_no_usage()

        with patch(
            "app.services.llm.usage_tracker.asyncio.run_coroutine_threadsafe"
        ) as mock_sched:
            cb.on_llm_end(result)  # must not raise

        assert mock_sched.called
        args, _ = mock_sched.call_args
        await args[0]
        call_kwargs = writer.enqueue.await_args.kwargs
        assert call_kwargs["total_tokens"] == 0
        assert call_kwargs["api_calls"] == 1

    @pytest.mark.asyncio
    async def test_cost_estimate_is_computed(self) -> None:
        writer = _FakeWriter()
        cb = UsageTrackingCallback(
            uid=1,
            provider="openai",
            model="gpt-4o",
            writer=writer,  # type: ignore[arg-type]
        )
        result = _make_llm_result(1_000_000, 1_000_000, 2_000_000)

        with patch(
            "app.services.llm.usage_tracker.asyncio.run_coroutine_threadsafe"
        ) as mock_sched:
            cb.on_llm_end(result)

        assert mock_sched.called
        args, _ = mock_sched.call_args
        await args[0]
        call_kwargs = writer.enqueue.await_args.kwargs
        assert call_kwargs["cost_estimate"] == 20.0  # 5 + 15


# ═══════════════════════════════════════════════════════════════
# on_llm_end exception isolation
# ═══════════════════════════════════════════════════════════════


class TestOnLlmEndExceptionIsolation:
    """``on_llm_end`` must never re-raise (LangChain would corrupt the response)."""

    @pytest.mark.asyncio
    async def test_run_coroutine_threadsafe_raising_is_swallowed(self) -> None:
        cb = UsageTrackingCallback(uid=1, writer=_FakeWriter())  # type: ignore[arg-type]
        result = _make_llm_result(1, 1, 2)

        with patch(
            "app.services.llm.usage_tracker.asyncio.run_coroutine_threadsafe",
            side_effect=RuntimeError("scheduler exploded"),
        ):
            # Must not raise
            cb.on_llm_end(result)


# ═══════════════════════════════════════════════════════════════
# Cross-thread integration: real scheduling across threads
# ═══════════════════════════════════════════════════════════════


class TestCrossThreadIntegration:
    """End-to-end: ``on_llm_end`` called from a worker thread schedules
    onto the main loop captured at ``__init__`` time.

    This reproduces the original bug scenario (LangChain executor thread
    invoking sync callback with no event loop) and verifies the fix.
    """

    @pytest.mark.asyncio
    async def test_callback_fired_from_worker_thread_enqueues_on_main_loop(self) -> None:
        writer = _FakeWriter()
        cb = UsageTrackingCallback(
            uid=99,
            credential_id=None,
            provider="openai",
            model="gpt-4o",
            writer=writer,  # type: ignore[arg-type]
        )
        main_loop = asyncio.get_running_loop()
        assert cb._loop is main_loop

        done = threading.Event()
        error_box: list[BaseException] = []

        def worker() -> None:
            # In the worker thread, there's no running loop — this is
            # exactly the LangChain executor scenario.
            try:
                result = _make_llm_result(50, 60, 110)
                cb.on_llm_end(result)
            except BaseException as e:
                error_box.append(e)
            finally:
                done.set()

        t = threading.Thread(target=worker)
        t.start()
        await asyncio.wait_for(asyncio.to_thread(done.wait, timeout=2.0), timeout=3.0)
        t.join(timeout=1.0)

        assert not error_box, f"worker thread raised: {error_box}"

        # Allow the scheduled coroutine to execute on the main loop
        await asyncio.sleep(0.05)

        writer.enqueue.assert_awaited_once()
        call_kwargs = writer.enqueue.await_args.kwargs
        assert call_kwargs["uid"] == 99
        assert call_kwargs["total_tokens"] == 110
        assert call_kwargs["prompt_tokens"] == 50
        assert call_kwargs["completion_tokens"] == 60
        assert "cost_estimate" in call_kwargs


# ═══════════════════════════════════════════════════════════════
# attach_usage_tracking helper
# ═══════════════════════════════════════════════════════════════


class TestAttachUsageTracking:
    """``attach_usage_tracking`` wires callbacks without mutating existing ones."""

    def test_appends_callback(self) -> None:
        from langchain_openai import ChatOpenAI
        from app.services.llm.usage_tracker import attach_usage_tracking

        llm = ChatOpenAI(api_key="sk-test", model="gpt-4o")
        assert not getattr(llm, "callbacks", None)
        attached = attach_usage_tracking(
            llm, uid=1, provider="openai", model="gpt-4o", writer=None
        )
        assert attached is llm
        assert len(llm.callbacks) == 1
        assert isinstance(llm.callbacks[0], UsageTrackingCallback)

    def test_preserves_existing_callbacks(self) -> None:
        from langchain_openai import ChatOpenAI
        from app.services.llm.usage_tracker import attach_usage_tracking

        llm = ChatOpenAI(api_key="sk-test", model="gpt-4o")
        llm.callbacks = ["existing"]
        attach_usage_tracking(llm, uid=1, provider="openai", model="gpt-4o")
        assert len(llm.callbacks) == 2
        assert llm.callbacks[0] == "existing"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
