"""Tests for the context-compression wiring (``app/context/auto_compress.py``).

Covers:

- SessionCompressorRegistry: record_turn → add_turn + threshold-triggered
  compression (store trimmed to the recent window, summary cached)
- Below-threshold turns: no compression, no cache write
- Cooldown: no immediate recompression right after one fires
- Restart continuity: a fresh registry seeds the accumulated summary from
  the Redis mirror (restore) and merges on the next compression
- Read path: DBChatDeps.get_conversation_context prepends the cached summary
"""

from __future__ import annotations

import asyncio
from typing import List

import pytest

from app.context import ContextManager, ConversationMessage
from app.context import cache as ctx_cache
from app.context.auto_compress import (
    SessionCompressorRegistry,
    init_auto_compressor,
    get_auto_compressor,
    reset_auto_compressor,
)

# NOTE: auto_compress binds ``get_cached``/``set_cached`` at import time, so
# tests must patch THIS namespace, not ``app.context.cache``.
import app.context.auto_compress as ac


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


async def _fake_summarize(
    old: List[ConversationMessage], recent, previous_summary
) -> str:
    """Deterministic SummarizeFn that merges the previous summary, mirroring
    the real prompt's incremental-merge contract."""
    base = f"SUMMARY(absorbed={len(old)})"
    if previous_summary:
        return f"{base} merged(prev: {previous_summary})"
    return base


async def _drain_pending_tasks() -> None:
    """Await all pending background tasks spawned by record_turn."""
    pending = [
        t for t in asyncio.all_tasks() if t is not asyncio.current_task()
    ]
    if pending:
        await asyncio.gather(*pending)


async def _feed_turns(reg: SessionCompressorRegistry, session_id: str, n: int):
    """Drive n completed turns through the real background path."""
    for i in range(1, n + 1):
        reg.record_turn(session_id, f"q{i}", f"a{i}")
        await _drain_pending_tasks()


@pytest.fixture
def registry():
    """Registry with a deterministic summarize_fn and TOKEN thresholds tuned
    so a single test can hit each branch.

    Each fake turn (``q{i}`` / ``a{i}``) estimates to ~10 tokens (2 tiny
    contents + 4/message overhead), so token_budget=25 fires on the 3rd turn;
    cooldown_turns=2 then blocks the next 2 turns.
    """
    cm = ContextManager()
    return SessionCompressorRegistry(
        cm,
        summarize_fn=_fake_summarize,
        max_recent_turns=2,
        token_budget=25,
        min_turns=2,
        cooldown_turns=2,
    )


# ---------------------------------------------------------------------------
# compression trigger & store trimming
# ---------------------------------------------------------------------------


class TestCompressionTrigger:
    @pytest.mark.asyncio
    async def test_below_threshold_no_compression(self, registry):
        cm = registry._cm
        await _feed_turns(registry, "s1", 2)  # ~20 tokens <= budget 25 → not fired
        assert await cm.turn_count("s1") == 2
        stored = await cm.get_context_raw("s1")
        assert len(stored) == 4
        assert registry.compressor_for("s1") is None or (
            registry.compressor_for("s1").summary is None
        )

    @pytest.mark.asyncio
    async def test_crossing_threshold_compresses_and_trims(self, registry):
        cm = registry._cm
        await _feed_turns(registry, "s1", 3)  # ~30 tokens > budget 25 → fires
        raw = await cm.get_context_raw("s1")
        # Store trimmed to the recent window (max_recent_turns=2 → ≤4 msgs);
        # older messages absorbed into the summary.
        assert len(raw) <= 4
        assert len(raw) < 6  # definitely trimmed, not the full 3-turn history
        comp = registry.compressor_for("s1")
        assert comp is not None
        assert comp.summary.startswith("SUMMARY(absorbed=")

    @pytest.mark.asyncio
    async def test_cooldown_prevents_immediate_recompression(self, registry):
        await _feed_turns(registry, "s1", 3)  # fires once
        first = registry.compressor_for("s1").summary
        # +1 turn: tokens grow past budget again BUT turns_since_last=1 <
        # cooldown=2 → must stay blocked.
        await _feed_turns(registry, "s1", 1)
        assert registry.compressor_for("s1").summary == first

    @pytest.mark.asyncio
    async def test_summary_cached_after_compression(self, registry, monkeypatch):
        stored: dict = {}

        async def _record(session_id, result, ttl=None):
            stored["session"] = session_id
            stored["summary"] = result.summary

        async def _none(_sid):
            return None

        monkeypatch.setattr(ac, "set_cached", _record)
        monkeypatch.setattr(ac, "get_cached", _none)

        await _feed_turns(registry, "s1", 3)
        assert stored.get("session") == "s1"
        assert str(stored.get("summary", "")).startswith("SUMMARY(absorbed=")


# ---------------------------------------------------------------------------
# restart continuity
# ---------------------------------------------------------------------------


class TestRestartContinuity:
    @pytest.mark.asyncio
    async def test_new_registry_seeds_summary_from_cache(
        self, registry, monkeypatch
    ):
        await _feed_turns(registry, "s1", 4)
        accumulated = registry.compressor_for("s1").summary

        # Simulate a restart: fresh ContextManager + registry, but the Redis
        # mirror still holds the previous summary.
        async def _cached_with_summary(_sid):
            return ctx_cache.CachedSummary(
                summary=accumulated,
                kept_message_count=4,
                compressed_count=2,
                cached_at=0.0,
            )

        monkeypatch.setattr(ac, "get_cached", _cached_with_summary)

        async def _noop_set(session_id, result, ttl=None):
            pass

        monkeypatch.setattr(ac, "set_cached", _noop_set)

        cm2 = ContextManager()
        reg2 = SessionCompressorRegistry(
            cm2,
            summarize_fn=_fake_summarize,
            max_recent_turns=1,  # tiny recent window → old part is non-empty
            token_budget=15,  # low budget: fires from the 2nd turn on
            min_turns=1,
            cooldown_turns=0,
        )
        await _feed_turns(reg2, "s1", 4)
        merged = reg2.compressor_for("s1").summary
        # The new summary must merge the restored one, not start over.
        assert "merged" in merged
        assert accumulated in merged


# ---------------------------------------------------------------------------
# read path (db_deps.get_conversation_context)
# ---------------------------------------------------------------------------


class _Msg:
    role = "user"
    content = ""


class _FakeDB:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def _make_deps_with_history(monkeypatch, messages):
    from app.agent.chat.db_deps import DBChatDeps

    deps = DBChatDeps.__new__(DBChatDeps)  # skip __init__ wiring

    async def _fake_get_session():
        return _FakeDB()

    deps._get_session = _fake_get_session

    import app.services.chat_history as history

    async def _fake_recent_turns(db, **kwargs):
        return messages

    monkeypatch.setattr(history, "get_recent_turns_for_user", _fake_recent_turns)
    return deps


class TestReadPath:
    @pytest.mark.asyncio
    async def test_conversation_context_prepends_summary(self, monkeypatch):
        async def _cached_with_summary(_sid):
            return ctx_cache.CachedSummary(
                summary="用户在研究 Rust 所有权",
                kept_message_count=6,
                compressed_count=10,
                cached_at=0.0,
            )

        monkeypatch.setattr(ctx_cache, "get_cached", _cached_with_summary)

        msg = _Msg()
        msg.content = "最近的问题"
        deps = _make_deps_with_history(monkeypatch, [msg])

        out = await deps.get_conversation_context("sess", uid=1)
        assert out.startswith("【历史摘要】")
        assert "Rust 所有权" in out
        assert "[用户] 最近的问题" in out

    @pytest.mark.asyncio
    async def test_conversation_context_without_summary_unchanged(
        self, monkeypatch
    ):
        async def _none(_sid):
            return None

        monkeypatch.setattr(ctx_cache, "get_cached", _none)

        msg = _Msg()
        msg.content = "只有近期对话"
        deps = _make_deps_with_history(monkeypatch, [msg])

        out = await deps.get_conversation_context("sess", uid=1)
        assert not out.startswith("【历史摘要】")
        assert out == "[用户] 只有近期对话"


# ---------------------------------------------------------------------------
# singleton lifecycle
# ---------------------------------------------------------------------------


class TestBudgetDerivation:
    """Default token budget must scale with the active model's context window
    — a hardcoded budget would over-compress on big-window models."""

    def _patch_window(self, monkeypatch, window: int):
        from app.config import settings

        monkeypatch.setattr(
            type(settings), "llm_context_window", property(lambda self: window)
        )

    def test_derives_half_of_context_window(self, monkeypatch):
        self._patch_window(monkeypatch, 131072)  # qwen-plus class
        reg = SessionCompressorRegistry(
            ContextManager(), summarize_fn=_fake_summarize
        )
        assert reg._token_budget == 131072 // 2

    def test_big_window_model_gets_big_budget(self, monkeypatch):
        self._patch_window(monkeypatch, 1_000_000)  # 1M-class
        reg = SessionCompressorRegistry(
            ContextManager(), summarize_fn=_fake_summarize
        )
        assert reg._token_budget == 500_000

    def test_tiny_window_clamped_to_minimum(self, monkeypatch):
        self._patch_window(monkeypatch, 2048)
        reg = SessionCompressorRegistry(
            ContextManager(), summarize_fn=_fake_summarize
        )
        assert reg._token_budget == 4000  # _MIN_TOKEN_BUDGET floor

    def test_explicit_param_wins_over_derivation(self, monkeypatch):
        self._patch_window(monkeypatch, 131072)
        reg = SessionCompressorRegistry(
            ContextManager(),
            summarize_fn=_fake_summarize,
            token_budget=25,  # explicit override (tests rely on this)
        )
        assert reg._token_budget == 25

    def test_auto_resolves_from_model_name(self, monkeypatch):
        """context_window=0 (auto) → window comes from the model registry."""
        from app.config import settings

        monkeypatch.setattr(
            type(settings), "llm_context_window", property(lambda self: 0)
        )
        monkeypatch.setattr(
            type(settings),
            "llm_model",
            property(lambda self: "google/gemini-2.5-pro"),
        )
        reg = SessionCompressorRegistry(
            ContextManager(), summarize_fn=_fake_summarize
        )
        assert reg._token_budget == 1_048_576 // 2


class TestSingleton:
    def teardown_method(self):
        reset_auto_compressor()

    def test_init_and_reset(self):
        cm = ContextManager()
        reg = init_auto_compressor(context_manager=cm, summarize_fn=_fake_summarize)
        assert get_auto_compressor() is reg
        reset_auto_compressor()
        assert get_auto_compressor() is None

    def test_requires_llm_or_summarize_fn(self):
        with pytest.raises(ValueError):
            SessionCompressorRegistry(ContextManager())
