"""Schema definitions for golden set samples and evaluation reports.

All dataclasses are frozen to enforce immutability — any "update" must
produce a new instance via ``dataclasses.replace``.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable, Iterator, Literal, Optional

# ---------------------------------------------------------------------------
# Golden set
# ---------------------------------------------------------------------------

# Restricted to the modes the chat router actually dispatches.
ScopeLiteral = Literal["vector", "direct", "db_list", "db_content"]

CategoryLiteral = Literal[
    "single_video",
    "cross_video",
    "negation",
    "proper_noun",
    "numeric_fact",
    "abstract",
]


@dataclass(frozen=True)
class GoldenSample:
    """One evaluation question.

    Fields mirror ``golden_set.jsonl`` schema; missing optional fields
    default to safe values so partially-filled rows still validate.
    """

    qid: str
    category: CategoryLiteral
    question: str
    scope: ScopeLiteral
    folder_ids: tuple[str, ...] = ()
    must_contain_bvid: tuple[str, ...] = ()
    must_contain_keywords: tuple[str, ...] = ()
    expected_answer_points: tuple[str, ...] = ()
    negative_keywords: tuple[str, ...] = ()
    min_chunks: int = 0
    tags: tuple[str, ...] = ()
    created_at: Optional[str] = None
    owner: Optional[str] = None

    @classmethod
    def from_dict(cls, raw: dict) -> "GoldenSample":
        # Normalize list -> tuple for immutability.
        def _t(key: str) -> tuple:
            value = raw.get(key) or ()
            return tuple(value)

        return cls(
            qid=str(raw["qid"]),
            category=raw["category"],
            question=raw["question"],
            scope=raw["scope"],
            folder_ids=_t("folder_ids"),
            must_contain_bvid=_t("must_contain_bvid"),
            must_contain_keywords=_t("must_contain_keywords"),
            expected_answer_points=_t("expected_answer_points"),
            negative_keywords=_t("negative_keywords"),
            min_chunks=int(raw.get("min_chunks", 0)),
            tags=_t("tags"),
            created_at=raw.get("created_at"),
            owner=raw.get("owner"),
        )


def load_golden_set(path: Path) -> list[GoldenSample]:
    """Read JSONL file into ``GoldenSample`` list. Skips blank/comment lines."""

    samples: list[GoldenSample] = []
    with path.open("r", encoding="utf-8") as f:
        for line_no, raw_line in enumerate(f, 1):
            line = raw_line.strip()
            if not line or line.startswith("//") or line.startswith("#"):
                continue
            try:
                samples.append(GoldenSample.from_dict(json.loads(line)))
            except (json.JSONDecodeError, KeyError, TypeError) as exc:
                raise ValueError(
                    f"golden_set.jsonl line {line_no} invalid: {exc}"
                ) from exc
    return samples


def validate_golden_set(samples: Iterable[GoldenSample]) -> list[str]:
    """Return a list of validation problems (empty list = healthy)."""

    problems: list[str] = []
    seen_qids: set[str] = set()
    valid_categories = set(CategoryLiteral.__args__)
    valid_scopes = set(ScopeLiteral.__args__)

    for s in samples:
        if s.qid in seen_qids:
            problems.append(f"duplicate qid: {s.qid}")
        seen_qids.add(s.qid)

        if s.category not in valid_categories:
            problems.append(f"{s.qid}: invalid category {s.category!r}")
        if s.scope not in valid_scopes:
            problems.append(f"{s.qid}: invalid scope {s.scope!r}")
        if not s.question.strip():
            problems.append(f"{s.qid}: empty question")
        if s.scope == "vector" and not (s.must_contain_bvid or s.must_contain_keywords):
            problems.append(
                f"{s.qid}: vector scope requires must_contain_bvid or must_contain_keywords"
            )
    return problems


# ---------------------------------------------------------------------------
# Run report
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RetrievedChunk:
    """A single retrieved chunk surfaced into the report."""

    bvid: Optional[str]
    upload_uuid: Optional[str]
    title: Optional[str]
    content_preview: str  # truncated to ~400 chars
    score: Optional[float] = None


@dataclass(frozen=True)
class SampleResult:
    """Per-sample evaluation outcome."""

    qid: str
    category: CategoryLiteral
    scope: ScopeLiteral
    recall_at_5: float
    precision_at_5: float
    mrr_at_5: float  # rank-sensitive: 1/rank of first hit, 0 if no hit
    answer_quality: int  # 0-5
    citation_accuracy: float
    keyword_hit_rate: float  # what fraction of must_contain_keywords appear in answer
    latency_ms: int
    retrieved: tuple[RetrievedChunk, ...]
    answer: str
    judge_reasoning: str
    error: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class RunMeta:
    """Per-run metadata snapshot — used for diff & reproducibility."""

    run_id: str
    git_sha: Optional[str]
    tag: str
    started_at: str
    duration_sec: float
    sample_count: int
    embedding_model: Optional[str] = None
    llm_model: Optional[str] = None
    judge_model: Optional[str] = None
    total_judge_calls: int = 0
    config_snapshot: dict = field(default_factory=dict)


@dataclass(frozen=True)
class SummaryMetrics:
    """Aggregated metrics across all samples."""

    samples: int
    recall_at_5: float
    precision_at_5: float
    mrr_at_5: float
    answer_quality_avg: float
    citation_accuracy: float
    keyword_hit_rate: float
    latency_p50_ms: int
    latency_p95_ms: int
    latency_p99_ms: int
    by_category: dict  # category -> dict of metric -> float


@dataclass(frozen=True)
class RunReport:
    """The serialized report written to ``reports/<run_id>.json``."""

    meta: RunMeta
    summary: SummaryMetrics
    samples: tuple[SampleResult, ...]

    def to_dict(self) -> dict:
        return {
            "meta": asdict(self.meta),
            "summary": asdict(self.summary),
            "samples": [s.to_dict() for s in self.samples],
        }

    def iter_samples(self) -> Iterator[SampleResult]:
        return iter(self.samples)
