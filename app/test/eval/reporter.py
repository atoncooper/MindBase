"""Report writer: emits both a machine-readable JSON and a human Markdown.

Both files share the same basename (``<run_id>``) so they sort together
in directory listings.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

from .schema import RunReport, SampleResult


def _fmt_pct(value: float) -> str:
    return f"{value * 100:.1f}%"


def _category_table(by_category: dict) -> str:
    if not by_category:
        return "_(no per-category data)_\n"
    header = "| category | n | recall@5 | precision@5 | mrr@5 | answer_quality | citation_acc | kw_hit |\n"
    sep = "|---|---|---|---|---|---|---|---|\n"
    rows: list[str] = []
    for cat, m in sorted(by_category.items()):
        rows.append(
            "| {cat} | {n} | {r} | {p} | {mrr:.2f} | {q:.2f} | {c} | {k} |\n".format(
                cat=cat,
                n=int(m.get("n", 0)),
                r=_fmt_pct(m.get("recall_at_5", 0.0)),
                p=_fmt_pct(m.get("precision_at_5", 0.0)),
                mrr=m.get("mrr_at_5", 0.0),
                q=m.get("answer_quality_avg", 0.0),
                c=_fmt_pct(m.get("citation_accuracy", 0.0)),
                k=_fmt_pct(m.get("keyword_hit_rate", 0.0)),
            )
        )
    return header + sep + "".join(rows)


def _failure_section(samples: Iterable[SampleResult], score_threshold: int = 2) -> str:
    failures = [s for s in samples if s.answer_quality <= score_threshold or s.error]
    if not failures:
        return "_(none)_\n"
    lines: list[str] = []
    for s in failures:
        tag = "ERROR" if s.error else f"score={s.answer_quality}"
        first = (s.answer or "").strip().splitlines()[:1]
        preview = first[0] if first else ""
        if len(preview) > 160:
            preview = preview[:160] + "…"
        reason = s.error or s.judge_reasoning or "(no reasoning)"
        if len(reason) > 200:
            reason = reason[:200] + "…"
        lines.append(
            f"- **{s.qid}** [{tag}] recall={_fmt_pct(s.recall_at_5)} "
            f"latency={s.latency_ms}ms\n"
            f"  - answer: {preview or '(empty)'}\n"
            f"  - reason: {reason}\n"
        )
    return "".join(lines)


def render_markdown(report: RunReport) -> str:
    m = report.meta
    s = report.summary
    sections = [
        f"# Eval Run · `{m.run_id}`",
        "",
        f"- **tag:** `{m.tag}`",
        f"- **started:** {m.started_at}",
        f"- **duration:** {m.duration_sec:.1f}s",
        f"- **git_sha:** `{m.git_sha or 'n/a'}`",
        f"- **llm_model:** `{m.llm_model}` · **embedding:** `{m.embedding_model}` · **judge:** `{m.judge_model}`",
        f"- **judge_calls:** {m.total_judge_calls}",
        "",
        "## Summary",
        "",
        "| metric | value |",
        "|---|---|",
        f"| samples | {s.samples} |",
        f"| recall@5 | {_fmt_pct(s.recall_at_5)} |",
        f"| precision@5 | {_fmt_pct(s.precision_at_5)} |",
        f"| mrr@5 | {s.mrr_at_5:.3f} |",
        f"| answer_quality_avg | {s.answer_quality_avg:.2f} / 5 |",
        f"| citation_accuracy | {_fmt_pct(s.citation_accuracy)} |",
        f"| keyword_hit_rate | {_fmt_pct(s.keyword_hit_rate)} |",
        f"| latency p50 / p95 / p99 | {s.latency_p50_ms} / {s.latency_p95_ms} / {s.latency_p99_ms} ms |",
        "",
        "## By category",
        "",
        _category_table(s.by_category),
        "",
        "## Failures (score ≤ 2 or error)",
        "",
        _failure_section(report.samples),
        "",
        "## Config snapshot",
        "",
        "```json",
        json.dumps(m.config_snapshot, ensure_ascii=False, indent=2),
        "```",
        "",
    ]
    return "\n".join(sections)


def write_report(report: RunReport, reports_dir: Path) -> Path:
    """Write JSON + MD to ``reports_dir`` and return the JSON path."""

    reports_dir.mkdir(parents=True, exist_ok=True)
    base = report.meta.run_id
    json_path = reports_dir / f"{base}.json"
    md_path = reports_dir / f"{base}.md"

    json_path.write_text(
        json.dumps(report.to_dict(), ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    md_path.write_text(render_markdown(report), encoding="utf-8")
    return json_path
