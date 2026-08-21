"""Layer-2 compression quality runner — REAL summarizer + judge scoring.

Reads the same declarative scenarios as Layer 1
(``scenarios/compression_scenarios.json``), but runs each one through the
pipeline with a REAL LLM summarizer (provider-resolved, e.g. DashScope
qwen), then quantifies:

  - trigger correctness      : fired / not fired vs expectation
  - keyword survival         : summary_contains / summary_not_contains hits
  - fact retention           : judge scores whether post-compression memory
                               (summary + kept raw turns) still carries each
                               injected fact (0 / 0.5 / 1)
  - hallucination            : judge scores whether the summary asserts
                               anything absent from the absorbed dialogue
  - compression ratio        : estimated tokens(summary + kept) / original

Each scenario is repeated ``--repeats`` times (fresh state per repeat) to
report mean ± stdev — single-run LLM numbers are noise.

Usage::

    python -m app.test.eval.compression_quality_runner --repeats 3 \
        --out reports

Outputs ``compression_quality_report.json`` + ``.md`` in the output dir.
Zero third-party eval dependencies: the judge is a plain structured-output
call to the same provider (temperature=0, retry-once on parse failure).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import statistics
import time
from dataclasses import dataclass, field
from pathlib import Path

from app.context.tokens import estimate_tokens
from app.test.context.compression_harness import (
    CacheSink,
    load_scenarios,
)
from app.context import ContextManager
from app.context.auto_compress import SessionCompressorRegistry

# ---------------------------------------------------------------------------
# judge
# ---------------------------------------------------------------------------

_JUDGE_SYSTEM = (
    '你是严格的质量评测器。只输出一个 JSON 对象：{"score": <0到1的数字>, '
    '"reason": "<不超过40字的理由>"}。不要输出任何其他文字。'
)


def _parse_judge(text: str) -> tuple[float | None, str]:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None, "no json in judge response"
    try:
        data = json.loads(match.group(0))
        return max(0.0, min(1.0, float(data["score"]))), str(data.get("reason", ""))
    except Exception as exc:  # malformed json / missing key
        return None, f"judge parse failed: {exc}"


async def judge_score(llm, user_prompt: str) -> tuple[float | None, str]:
    """Ask the judge model; retry once on parse failure. None = unusable."""
    messages = [
        {"role": "system", "content": _JUDGE_SYSTEM},
        {"role": "user", "content": user_prompt},
    ]
    last_reason = "judge not called"
    for _ in range(2):
        try:
            resp = await llm.ainvoke(messages)
            content = getattr(resp, "content", resp)
            score, reason = _parse_judge(
                content if isinstance(content, str) else str(content)
            )
            if score is not None:
                return score, reason
            last_reason = reason
        except Exception as exc:
            last_reason = f"judge call failed: {exc}"
    return None, last_reason


_RETENTION_PROMPT = """【压缩后的对话记忆】
{memory}

【需要确认的事实】
{fact}

评分：若凭这段记忆，助手能够准确回忆起该事实（关键实体/数字/决定完整），score=1；
只能回忆起部分要点，score=0.5；事实丢失、被覆盖或被记错，score=0。"""


_HALLUCINATION_PROMPT = """【被压缩的原始对话】
{dialogue}

【由该对话生成的摘要】
{summary}

评分：摘要中的每一条具体断言都能在原始对话中找到依据，score=1；
存在个别原文没有的推断但无事实错误，score=0.5；出现原文完全没有的具体断言（编造），score=0。"""


# ---------------------------------------------------------------------------
# execution
# ---------------------------------------------------------------------------


@dataclass
class RepeatResult:
    repeat: int
    fired: bool
    summary: str
    kept_messages: int
    original_messages: int
    original_tokens: int
    memory_tokens: int
    compression_ratio: float | None
    keyword_hits: list[str]
    keyword_misses: list[str]
    keyword_violations: list[str]
    retention_scores: dict[str, float | None]  # fact_id -> score
    hallucination_score: float | None
    errors: list[str] = field(default_factory=list)


def _memory_text(summary: str, kept_text: str) -> str:
    return summary + ("\n" + kept_text if kept_text else "")


async def _run_once(scenario, llm, repeat: int, semaphore: asyncio.Semaphore) -> RepeatResult:
    from app.context import auto_compress as ac

    async with semaphore:
        cm = ContextManager()
        sink = CacheSink()

        # Fault injection must be honoured here too (Layer-1's factory does
        # the same): a "raise" fault tests degradation even when a real LLM
        # is configured.
        summarize_fn = None
        if scenario.inject_fault == "summarize_raise_wrapped":
            from app.context.compressor import build_summarize_fn as _bsf
            from app.test.context.compression_harness import raising_llm_invoke

            summarize_fn = _bsf(raising_llm_invoke())
        elif scenario.inject_fault == "summarize_raise_direct":
            from app.test.context.compression_harness import (
                raising_direct_summarize_fn,
            )

            summarize_fn = raising_direct_summarize_fn

        registry = SessionCompressorRegistry(
            cm,
            llm=llm,
            summarize_fn=summarize_fn,
            token_budget=scenario.config.token_budget,
            max_recent_turns=scenario.config.max_recent_turns,
            min_turns=scenario.config.min_turns,
            cooldown_turns=scenario.config.cooldown_turns,
        )

        orig_set, orig_get = ac.set_cached, ac.get_cached
        ac.set_cached = sink.set_cached
        ac.get_cached = sink.get_cached
        errors: list[str] = []
        try:
            session_id = f"{scenario.scenario_id}-r{repeat}"
            msgs = scenario.turns
            for i in range(0, len(msgs) - 1, 2):
                # Direct await (NOT record_turn): the runner runs many
                # scenarios concurrently — drain_pending() would gather
                # sibling runs' tasks and deadlock on the semaphore.
                await registry._on_turn(
                    session_id, msgs[i].content, msgs[i + 1].content
                )

            compressor = registry.compressor_for(session_id)
            fired = compressor is not None and compressor.summary is not None
            # Coalesce None: blocked/no-op runs leave summary as None.
            summary = (compressor.summary if compressor else "") or ""
            stored = await cm.get_context_raw(session_id)

            # ---- mechanical ----
            hits = [k for k in scenario.layer1.summary_contains if k in summary]
            misses = [k for k in scenario.layer1.summary_contains if k not in summary]
            violations = [
                k for k in scenario.layer1.summary_not_contains if k in summary
            ]

            # ---- quantities ----
            original_tokens = sum(
                estimate_tokens(m.content) for m in msgs
            )
            kept_text = "\n".join(m.content for m in stored)
            memory_tokens = estimate_tokens(summary) + estimate_tokens(kept_text)
            ratio = (
                round(memory_tokens / original_tokens, 4)
                if original_tokens > 0 and fired
                else None
            )

            # ---- judge: fact retention over post-compression memory ----
            memory = _memory_text(summary, kept_text)
            retention: dict[str, float | None] = {}
            for fact in scenario.injected_facts:
                score, reason = await judge_score(
                    llm,
                    _RETENTION_PROMPT.format(memory=memory, fact=fact.text),
                )
                retention[fact.fact_id] = score
                if score is None:
                    errors.append(f"retention {fact.fact_id}: {reason}")

            # ---- judge: hallucination over the ABSORBED part only ----
            hallucination: float | None = None
            if fired and summary:
                kept_contents = {m.content for m in stored}
                absorbed = [
                    m.content
                    for m in msgs
                    if m.content not in kept_contents
                ]
                if absorbed:
                    dialogue = "\n".join(absorbed)
                    hallucination, reason = await judge_score(
                        llm,
                        _HALLUCINATION_PROMPT.format(
                            dialogue=dialogue, summary=summary
                        ),
                    )
                    if hallucination is None:
                        errors.append(f"hallucination: {reason}")

            return RepeatResult(
                repeat=repeat,
                fired=fired,
                summary=summary,
                kept_messages=len(stored),
                original_messages=len(msgs),
                original_tokens=original_tokens,
                memory_tokens=memory_tokens,
                compression_ratio=ratio,
                keyword_hits=hits,
                keyword_misses=misses,
                keyword_violations=violations,
                retention_scores=retention,
                hallucination_score=hallucination,
                errors=errors,
            )
        except Exception as exc:
            errors.append(f"pipeline: {exc}")
            return RepeatResult(
                repeat=repeat,
                fired=False,
                summary="",
                kept_messages=0,
                original_messages=0,
                original_tokens=0,
                memory_tokens=0,
                compression_ratio=None,
                keyword_hits=[],
                keyword_misses=[],
                keyword_violations=[],
                retention_scores={},
                hallucination_score=None,
                errors=errors,
            )
        finally:
            ac.set_cached = orig_set
            ac.get_cached = orig_get


# ---------------------------------------------------------------------------
# aggregation + reporting
# ---------------------------------------------------------------------------


def _mean(values: list[float]) -> float | None:
    clean = [v for v in values if v is not None]
    return round(statistics.mean(clean), 4) if clean else None


def _std(values: list[float]) -> float | None:
    clean = [v for v in values if v is not None]
    return round(statistics.stdev(clean), 4) if len(clean) >= 2 else None


def _aggregate(scenario, results: list[RepeatResult]) -> dict:
    all_retention: dict[str, list[float]] = {}
    for r in results:
        for fid, score in r.retention_scores.items():
            all_retention.setdefault(fid, []).append(score)

    flat_retention = [v for vals in all_retention.values() for v in vals]
    expected_keywords = sum(len(scenario.layer1.summary_contains) for _ in results)
    hit_keywords = sum(len(r.keyword_hits) for r in results)

    return {
        "fired_runs": sum(1 for r in results if r.fired),
        "runs": len(results),
        "keyword_recall": (
            round(hit_keywords / expected_keywords, 4) if expected_keywords else None
        ),
        "keyword_violations": sum(len(r.keyword_violations) for r in results),
        "retention_mean": _mean(flat_retention),
        "retention_std": _std(flat_retention),
        "retention_by_fact": {
            fid: {"mean": _mean(vals), "n": len(vals)}
            for fid, vals in all_retention.items()
        },
        "hallucination_mean": _mean([r.hallucination_score for r in results]),
        "compression_ratio_mean": _mean([r.compression_ratio for r in results]),
        "errors": [e for r in results for e in r.errors],
    }


def _by_fact_type(scenarios, aggregated: dict[str, dict]) -> dict:
    """Group retention means by injected-fact type."""
    out: dict[str, list[float]] = {}
    for scenario in scenarios:
        agg = aggregated.get(scenario.scenario_id)
        if not agg:
            continue
        for fact in scenario.injected_facts:
            entry = agg["retention_by_fact"].get(fact.fact_id)
            if entry and entry["mean"] is not None:
                out.setdefault(fact.type, []).append(entry["mean"])
    return {
        k: {"mean": _mean(v), "n": len(v)} for k, v in out.items() if v
    }


def _markdown(report: dict) -> str:
    lines = [
        "# 上下文压缩质量报告（Layer 2）",
        "",
        f"- 时间：{report['meta']['timestamp']}",
        f"- 模型：{report['meta']['model']} @ {report['meta']['provider']}",
        f"- 重复次数：{report['meta']['repeats']} / 场景",
        f"- 场景数：{len(report['scenarios'])}",
        "",
        "## 总览",
        "",
        "| 指标 | 值 | 门禁 | 结果 |",
        "|------|----|------|------|",
    ]
    overall = report["overall"]
    gates = [
        ("关键词召回率", overall["keyword_recall"], 0.9),
        ("事实保留均值(judge)", overall["retention_mean"], 0.9),
        ("无幻觉均值(judge)", overall["hallucination_mean"], 0.98),
        ("平均压缩比", overall["compression_ratio_mean"], 0.30),
    ]
    for name, value, gate in gates:
        if value is None:
            lines.append(f"| {name} | n/a | ≤{gate} / ≥{gate} | ⚠️ 无数据 |")
            continue
        ok = value >= gate if name != "平均压缩比" else value <= gate
        lines.append(f"| {name} | {value} | {'≥' if name != '平均压缩比' else '≤'}{gate} | {'✅' if ok else '❌'} |")

    lines += ["", "## 分场景", "", "| 场景 | 触发 | 关键词召回 | 保留均值 | 幻觉 | 压缩比 | 错误 |", "|------|------|-----------|---------|------|--------|------|"]
    for sid, agg in report["scenarios"].items():
        lines.append(
            f"| {sid} | {agg['fired_runs']}/{agg['runs']} "
            f"| {agg['keyword_recall']} | {agg['retention_mean']} "
            f"| {agg['hallucination_mean']} | {agg['compression_ratio_mean']} "
            f"| {len(agg['errors'])} |"
        )

    lines += ["", "## 按事实类型", "", "| 类型 | 保留均值 | 样本数 |", "|------|---------|--------|"]
    for ftype, entry in report.get("by_fact_type", {}).items():
        lines.append(f"| {ftype} | {entry['mean']} | {entry['n']} |")

    errors = [e for agg in report["scenarios"].values() for e in agg["errors"]]
    if errors:
        lines += ["", "## 错误明细", ""] + [f"- {e}" for e in errors[:20]]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


async def main_async(repeats: int, out_dir: Path) -> None:
    from app.services.llm.providers import resolve_llm_config

    cfg = resolve_llm_config()
    from langchain_openai import ChatOpenAI

    llm = ChatOpenAI(
        api_key=cfg.api_key,
        base_url=cfg.base_url,
        model=cfg.model,
        temperature=0,
        timeout=60,
        **({"default_headers": dict(cfg.default_headers)} if cfg.default_headers else {}),
    )

    scenarios = load_scenarios()
    semaphore = asyncio.Semaphore(4)
    started = time.time()

    report: dict = {
        "meta": {
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "provider": cfg.provider,
            "model": cfg.model,
            "repeats": repeats,
            "note": "budget 来自场景文件（为快速触发而设的小值），不代表生产默认值；"
                    "压缩比在微型对话上被摘要固定结构（六个章节头）主导，数值偏高，"
                    "仅用于横向对比场景，不代表真实长会话的压缩率",
        },
        "scenarios": {},
    }

    tasks = {}
    for scenario in scenarios:
        for r in range(repeats):
            tasks[(scenario.scenario_id, r)] = _run_once(
                scenario, llm, r, semaphore
            )
    results_map = await asyncio.gather(*tasks.values())
    keyed = dict(zip(tasks.keys(), results_map))

    for scenario in scenarios:
        results = [
            keyed[(scenario.scenario_id, r)] for r in range(repeats)
        ]
        report["scenarios"][scenario.scenario_id] = {
            "description": scenario.description,
            "results": [
                {
                    "repeat": r.repeat,
                    "fired": r.fired,
                    "summary": r.summary[:400],
                    "keyword_hits": r.keyword_hits,
                    "keyword_misses": r.keyword_misses,
                    "keyword_violations": r.keyword_violations,
                    "retention_scores": r.retention_scores,
                    "hallucination_score": r.hallucination_score,
                    "compression_ratio": r.compression_ratio,
                    "original_tokens": r.original_tokens,
                    "memory_tokens": r.memory_tokens,
                    "errors": r.errors,
                }
                for r in results
            ],
            **_aggregate(scenario, results),
        }

    report["overall"] = {
        "keyword_recall": _mean(
            [a["keyword_recall"] for a in report["scenarios"].values() if a["keyword_recall"] is not None]
        ),
        "retention_mean": _mean(
            [a["retention_mean"] for a in report["scenarios"].values() if a["retention_mean"] is not None]
        ),
        "hallucination_mean": _mean(
            [a["hallucination_mean"] for a in report["scenarios"].values() if a["hallucination_mean"] is not None]
        ),
        "compression_ratio_mean": _mean(
            [a["compression_ratio_mean"] for a in report["scenarios"].values() if a["compression_ratio_mean"] is not None]
        ),
        "total_errors": sum(
            len(a["errors"]) for a in report["scenarios"].values()
        ),
    }
    report["by_fact_type"] = _by_fact_type(scenarios, report["scenarios"])

    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "compression_quality_report.json"
    md_path = out_dir / "compression_quality_report.md"
    json_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    md_path.write_text(_markdown(report), encoding="utf-8")

    print(f"[DONE] {time.time() - started:.1f}s → {json_path}")
    print(f"       overall: {json.dumps(report['overall'], ensure_ascii=False)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument(
        "--out", type=Path, default=Path(__file__).resolve().parents[3] / "reports"
    )
    args = parser.parse_args()
    asyncio.run(main_async(args.repeats, args.out))


if __name__ == "__main__":
    main()
