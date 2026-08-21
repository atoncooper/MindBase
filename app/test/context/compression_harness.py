"""Compression scenario harness — load scenarios, drive the real pipeline.

A *scenario* is a self-contained test fixture for the context-compression
pipeline: a scripted conversation, optional injected facts, tuning config,
and Layer-1 expectations.  The same file feeds every test layer:

- Layer 1 (CI, fake summarize)  → mechanical assertions only
- Layer 2/3 (PR/daily, real qwen + judge) → semantic assertions on the same
  ``turns`` / ``injected_facts`` / ``probes``

This module owns loading + validation (:func:`load_scenarios`) and execution
(:func:`run_scenario`).  Assertion logic lives in the test files.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from app.context import ContextManager
from app.context.auto_compress import SessionCompressorRegistry
from app.context.cache import CachedSummary
from app.context.compressor import build_summarize_fn
from app.context.models import ConversationMessage

DEFAULT_SCENARIO_PATH = (
    Path(__file__).parent / "scenarios" / "compression_scenarios.json"
)

_VALID_ROLES = {"user", "assistant"}
_VALID_FAULTS = {None, "summarize_raise_wrapped", "summarize_raise_direct"}


# ---------------------------------------------------------------------------
# schema
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Turn:
    role: str
    content: str


@dataclass(frozen=True)
class InjectedFact:
    fact_id: str
    type: str
    text: str


@dataclass(frozen=True)
class Probe:
    question: str
    must_contain: list[str] = field(default_factory=list)
    must_not: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ScenarioConfig:
    token_budget: int
    max_recent_turns: int
    min_turns: int
    cooldown_turns: int


@dataclass(frozen=True)
class Layer1Expectations:
    expect_compression: bool
    summary_contains: list[str] = field(default_factory=list)
    summary_not_contains: list[str] = field(default_factory=list)
    store_max_messages: Optional[int] = None
    store_contains_fact_text: Optional[str] = None
    expect_set_cached_calls: Optional[int] = None
    expect_store_grows_unbounded: bool = False


@dataclass(frozen=True)
class Scenario:
    scenario_id: str
    description: str
    config: ScenarioConfig
    turns: list[Turn]
    layer1: Layer1Expectations
    injected_facts: list[InjectedFact] = field(default_factory=list)
    probes: list[Probe] = field(default_factory=list)
    inject_fault: Optional[str] = None

    def message(self, turn: Turn) -> ConversationMessage:
        return ConversationMessage(role=turn.role, content=turn.content)


# ---------------------------------------------------------------------------
# loading + validation
# ---------------------------------------------------------------------------


def _require(cond: bool, msg: str) -> None:
    if not cond:
        raise ValueError(msg)


def _parse_turn(raw: dict, sid: str, idx: int) -> Turn:
    _require(isinstance(raw, dict), f"{sid}: turns[{idx}] must be an object")
    role = raw.get("role")
    content = raw.get("content", "")
    _require(
        role in _VALID_ROLES,
        f"{sid}: turns[{idx}].role must be one of {_VALID_ROLES}, got {role!r}",
    )
    _require(isinstance(content, str) and content, f"{sid}: turns[{idx}].content empty")
    return Turn(role=role, content=content)


def parse_scenario(raw: dict) -> Scenario:
    sid = raw.get("scenario_id") or "<missing>"
    _require(isinstance(raw, dict), "scenario must be an object")
    _require(bool(raw.get("scenario_id")), f"{sid}: scenario_id required")

    cfg_raw = raw.get("config") or {}
    for key in ("token_budget", "max_recent_turns", "min_turns", "cooldown_turns"):
        value = cfg_raw.get(key)
        _require(
            isinstance(value, int) and value >= 0,
            f"{sid}: config.{key} must be a non-negative int, got {value!r}",
        )
    config = ScenarioConfig(
        token_budget=cfg_raw["token_budget"],
        max_recent_turns=cfg_raw["max_recent_turns"],
        min_turns=cfg_raw["min_turns"],
        cooldown_turns=cfg_raw["cooldown_turns"],
    )

    turns_raw = raw.get("turns") or []
    _require(len(turns_raw) > 0, f"{sid}: at least one turn required")
    turns = [_parse_turn(t, sid, i) for i, t in enumerate(turns_raw)]

    facts = [
        InjectedFact(fact_id=f["id"], type=f.get("type", "entity"), text=f["text"])
        for f in (raw.get("injected_facts") or [])
    ]
    probes = [
        Probe(
            question=p["question"],
            must_contain=p.get("must_contain", []),
            must_not=p.get("must_not", []),
        )
        for p in (raw.get("probes") or [])
    ]

    fault = raw.get("inject_fault")
    _require(fault in _VALID_FAULTS, f"{sid}: unknown inject_fault={fault!r}")

    l1_raw = raw.get("layer1") or {}
    layer1 = Layer1Expectations(
        expect_compression=bool(l1_raw.get("expect_compression", False)),
        summary_contains=list(l1_raw.get("summary_contains", [])),
        summary_not_contains=list(l1_raw.get("summary_not_contains", [])),
        store_max_messages=l1_raw.get("store_max_messages"),
        store_contains_fact_text=l1_raw.get("store_contains_fact_text"),
        expect_set_cached_calls=l1_raw.get("expect_set_cached_calls"),
        expect_store_grows_unbounded=bool(
            l1_raw.get("expect_store_grows_unbounded", False)
        ),
    )

    return Scenario(
        scenario_id=raw["scenario_id"],
        description=raw.get("description", ""),
        config=config,
        turns=turns,
        layer1=layer1,
        injected_facts=facts,
        probes=probes,
        inject_fault=fault,
    )


def load_scenarios(path: Path | None = None) -> list[Scenario]:
    """Load and validate all scenarios; duplicate ids are a hard error."""
    path = path or DEFAULT_SCENARIO_PATH
    raw_list = json.loads(Path(path).read_text(encoding="utf-8"))
    _require(isinstance(raw_list, list), f"{path}: top level must be a JSON array")
    scenarios = [parse_scenario(raw) for raw in raw_list]
    ids = [s.scenario_id for s in scenarios]
    duplicates = {i for i in ids if ids.count(i) > 1}
    _require(not duplicates, f"{path}: duplicate scenario_ids={duplicates}")
    return scenarios


def get_scenario(scenario_id: str, path: Path | None = None) -> Scenario:
    matches = [s for s in load_scenarios(path) if s.scenario_id == scenario_id]
    _require(matches, f"scenario not found: {scenario_id}")
    return matches[0]


# ---------------------------------------------------------------------------
# execution
# ---------------------------------------------------------------------------


async def drain_pending() -> None:
    """Await every pending background task spawned by record_turn."""
    for _ in range(3):  # tasks never spawn further tasks; belt and braces
        pending = [
            t for t in asyncio.all_tasks() if t is not asyncio.current_task()
        ]
        if not pending:
            return
        await asyncio.gather(*pending)


def echo_summarize_fn():
    """Deterministic SummarizeFn: echoes absorbed old messages (plus the
    previous summary) into the new summary — makes 'fact survived the absorb
    step' mechanically assertable without an LLM."""

    async def _summarize(old, recent, previous_summary) -> str:
        body = "；".join(m.content.replace("\n", " ") for m in old)
        if previous_summary:
            body = f"{previous_summary}；{body}"
        return f"【摘要】{body}"

    return _summarize


def raising_llm_invoke():
    async def _invoke(messages):
        raise RuntimeError("simulated LLM outage")

    return _invoke


async def raising_direct_summarize_fn(old, recent, previous_summary) -> str:
    raise RuntimeError("simulated summarizer crash (direct)")


class CacheSink:
    """Stands in for the Redis cache layer; records set_cached writes."""

    def __init__(self) -> None:
        self.writes: list[tuple[str, str]] = []

    async def set_cached(self, session_id: str, result, ttl=None) -> None:
        self.writes.append((session_id, result.summary or ""))

    async def get_cached(self, session_id: str):
        for sid, summary in reversed(self.writes):
            if sid == session_id:
                return CachedSummary(
                    summary=summary,
                    kept_message_count=0,
                    compressed_count=0,
                    cached_at=time.time(),
                )
        return None


@dataclass
class CompressionRun:
    scenario: Scenario
    cm: ContextManager
    registry: SessionCompressorRegistry
    cache_sink: CacheSink
    session_id: str = "s1"

    @property
    def summary(self) -> Optional[str]:
        compressor = self.registry.compressor_for(self.session_id)
        return compressor.summary if compressor else None

    @property
    def set_cached_calls(self) -> int:
        return len(self.cache_sink.writes)

    async def stored_messages(self) -> list[ConversationMessage]:
        return await self.cm.get_context_raw(self.session_id)


async def run_scenario(scenario: Scenario) -> CompressionRun:
    """Drive one scenario through the REAL pipeline (ContextManager +
    SessionCompressorRegistry), capturing cache writes."""
    from app.context import auto_compress as ac

    cm = ContextManager()
    sink = CacheSink()

    if scenario.inject_fault == "summarize_raise_wrapped":
        summarize_fn = build_summarize_fn(raising_llm_invoke())
    elif scenario.inject_fault == "summarize_raise_direct":
        summarize_fn = raising_direct_summarize_fn
    else:
        summarize_fn = echo_summarize_fn()

    registry = SessionCompressorRegistry(
        cm,
        summarize_fn=summarize_fn,
        token_budget=scenario.config.token_budget,
        max_recent_turns=scenario.config.max_recent_turns,
        min_turns=scenario.config.min_turns,
        cooldown_turns=scenario.config.cooldown_turns,
    )

    orig_set, orig_get = ac.set_cached, ac.get_cached
    ac.set_cached = sink.set_cached
    ac.get_cached = sink.get_cached
    try:
        session_id = f"{scenario.scenario_id}-session"
        # Feed pairwise (user+assistant) exactly as production does.
        msgs = scenario.turns
        for i in range(0, len(msgs) - 1, 2):
            registry.record_turn(
                session_id, msgs[i].content, msgs[i + 1].content
            )
            await drain_pending()
        return CompressionRun(
            scenario=scenario,
            cm=cm,
            registry=registry,
            cache_sink=sink,
            session_id=session_id,
        )
    finally:
        ac.set_cached = orig_set
        ac.get_cached = orig_get
