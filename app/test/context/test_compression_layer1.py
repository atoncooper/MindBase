"""Layer-1 compression tests — mechanical assertions, zero real-LLM cost.

Driven entirely by the declarative scenarios in
``app/test/context/scenarios/compression_scenarios.json`` (T1-T7 + edges).
Runs on every commit: fake/deterministic summarize, no network.

What this layer proves: trigger math (token budget / min-turns / cooldown),
store trimming bounds, summary absorption of absorbed facts, cache-write
accounting, and fault tolerance.  It does NOT judge summarization *quality*
— that is Layer 2/3 (real qwen + DeepEval), built separately.
"""

from __future__ import annotations

import pytest

from app.test.context.compression_harness import (
    Scenario,
    drain_pending,
    echo_summarize_fn,
    get_scenario,
    load_scenarios,
    run_scenario,
)

# ---------------------------------------------------------------------------
# generic driver — every scenario in the JSON file
# ---------------------------------------------------------------------------


def _assert_layer1(run, scenario) -> None:
    exp = scenario.layer1
    sid = run.session_id

    if exp.expect_compression:
        assert run.summary is not None, f"{sid}: expected compression, none happened"
        for keyword in exp.summary_contains:
            assert keyword in (run.summary or ""), (
                f"{scenario.scenario_id}: summary missing {keyword!r}\n"
                f"summary={run.summary!r}"
            )
    else:
        assert run.summary is None, (
            f"{scenario.scenario_id}: expected NO compression, got summary"
        )

    for keyword in exp.summary_not_contains:
        assert keyword not in (run.summary or ""), (
            f"{scenario.scenario_id}: summary should not contain {keyword!r}"
        )

    if exp.expect_set_cached_calls is not None:
        assert run.set_cached_calls == exp.expect_set_cached_calls, (
            f"{scenario.scenario_id}: set_cached calls "
            f"{run.set_cached_calls} != {exp.expect_set_cached_calls}"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "scenario", load_scenarios(), ids=lambda s: s.scenario_id
)
async def test_scenario_layer1(scenario: Scenario):
    run = await run_scenario(scenario)
    exp = scenario.layer1

    _assert_layer1(run, scenario)

    stored = await run.stored_messages()

    if exp.store_max_messages is not None:
        assert len(stored) <= exp.store_max_messages, (
            f"{scenario.scenario_id}: store has {len(stored)} messages, "
            f"expected <= {exp.store_max_messages}"
        )

    if exp.expect_store_grows_unbounded:
        # No compression → every scripted message stays in the store.
        assert len(stored) == len(scenario.turns), (
            f"{scenario.scenario_id}: store trimmed unexpectedly "
            f"({len(stored)} != {len(scenario.turns)})"
        )

    if exp.expect_compression and stored:
        # Pair integrity: a trimmed window never opens on an orphan assistant.
        assert stored[0].role == "user", (
            f"{scenario.scenario_id}: kept window starts with assistant message"
        )

    if exp.store_contains_fact_text:
        joined = "".join(m.content for m in stored)
        assert exp.store_contains_fact_text in joined, (
            f"{scenario.scenario_id}: fact text "
            f"{exp.store_contains_fact_text!r} missing from raw store"
        )


# ---------------------------------------------------------------------------
# dedicated timeline tests (cannot be expressed as single-pass scenarios)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_T6_cooldown_timeline(monkeypatch):
    """Compression fires once, cooldown blocks the next N turns, then fires
    again exactly when the cooldown elapses."""
    import app.context.auto_compress as ac
    from app.context import ContextManager
    from app.context.auto_compress import SessionCompressorRegistry

    writes: list[str] = []

    async def _record(session_id, result, ttl=None):
        writes.append(result.summary or "")

    async def _none(_sid):
        return None

    monkeypatch.setattr(ac, "set_cached", _record)
    monkeypatch.setattr(ac, "get_cached", _none)

    cm = ContextManager()
    registry = SessionCompressorRegistry(
        cm,
        summarize_fn=echo_summarize_fn(),
        token_budget=15,
        max_recent_turns=1,
        min_turns=1,
        cooldown_turns=3,
    )
    sid = "t6"

    async def feed(i: int):
        registry.record_turn(sid, f"第{i}轮填充内容用来推高上下文", "收到")
        await drain_pending()

    # Turn 1 exceeds the budget but with max_recent_turns=1 there is nothing
    # older to absorb → the first REAL compression lands on turn 2.
    await feed(1)
    await feed(2)
    first_summary = registry.compressor_for(sid).summary
    assert first_summary is not None
    assert len(writes) == 1

    # Cooldown window: turns 3..5 must not recompress (checked with
    # turns_since_last = 1, 2, 3 — all < cooldown 3 at check time).
    for i in range(3, 6):
        await feed(i)
    assert len(writes) == 1
    assert registry.compressor_for(sid).summary == first_summary

    # Cooldown elapsed (turns_since_last == 3, not < 3) → fires again.
    await feed(6)
    assert len(writes) == 2


@pytest.mark.asyncio
async def test_multi_session_isolation():
    """Two interleaved sessions keep independent summaries/stores — no
    cross-contamination through the shared registry."""
    from app.context import ContextManager
    from app.context.auto_compress import SessionCompressorRegistry

    cm = ContextManager()
    registry = SessionCompressorRegistry(
        cm,
        summarize_fn=echo_summarize_fn(),
        token_budget=40,
        max_recent_turns=1,
        min_turns=2,
        cooldown_turns=0,
    )

    async def feed(sid: str, i: int, fact: str):
        registry.record_turn(sid, f"{fact}", "已记录")
        await drain_pending()
        registry.record_turn(sid, f"{sid} 填充内容第{i}轮", "嗯")
        await drain_pending()

    for i in range(1, 4):
        await feed("sess-a", i, "会话A收藏了《王德峰讲阳明心学》")
        await feed("sess-b", i, "会话B收藏了《朱熹理学思想》")

    sum_a = registry.compressor_for("sess-a").summary or ""
    sum_b = registry.compressor_for("sess-b").summary or ""
    assert "王德峰" in sum_a and "王德峰" not in sum_b
    assert "朱熹" in sum_b and "朱熹" not in sum_a


def test_scenario_catalog_integrity():
    """Every T-family must be represented; ids unique (loader also checks)."""
    scenarios = load_scenarios()
    ids = {s.scenario_id for s in scenarios}
    for family in ("T1", "T2", "T3", "T4", "T5", "T7"):
        assert any(sid.startswith(family) for sid in ids), (
            f"scenario family {family} missing from catalog"
        )
    assert get_scenario("E-canonical-smoke").scenario_id == "E-canonical-smoke"
