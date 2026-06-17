"""Eval run orchestrator.

Reads ``golden_set.jsonl``, invokes the RAG pipeline (via the production
``AgentHarness`` / ReAct chat agent so retrieval + answer paths match
production), scores the result with the LLM judge, computes metrics, and
writes a JSON+Markdown report under ``reports/``.

Usage::

    python -m app.test.eval.runner --tag baseline
    python -m app.test.eval.runner --tag rerank-v2 --samples 5 --category single_video
    python -m app.test.eval.runner --tag dryrun --dry-run

The harness is built standalone (no FastAPI app required) so this CLI
runs in CI without uvicorn.
"""

from __future__ import annotations

import argparse
import asyncio
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from loguru import logger

from app.config import settings

from .judge import JudgeVerdict, judge_answer
from .metrics import (
    aggregate,
    citation_accuracy,
    keyword_hit_rate,
    mrr_at_k,
    negative_keyword_penalty,
    precision_at_k,
    recall_at_k,
)
from .reporter import write_report
from .schema import (
    GoldenSample,
    RetrievedChunk,
    RunMeta,
    RunReport,
    SampleResult,
    load_golden_set,
    validate_golden_set,
)

EVAL_DIR = Path(__file__).resolve().parent
GOLDEN_PATH = EVAL_DIR / "golden_set.jsonl"
REPORTS_DIR = EVAL_DIR / "reports"

_BVID_RE = re.compile(r"BV[A-Za-z0-9]{10}")


# ---------------------------------------------------------------------------
# Pipeline invocation
# ---------------------------------------------------------------------------


def _doc_to_chunk(doc) -> RetrievedChunk:
    meta = doc.metadata or {}
    content = (doc.page_content or "").strip()
    if len(content) > 400:
        content = content[:400] + "…"
    score = meta.get("score")
    return RetrievedChunk(
        bvid=meta.get("bvid") or None,
        upload_uuid=meta.get("upload_uuid") or None,
        title=meta.get("title") or meta.get("filename") or None,
        content_preview=content,
        score=float(score) if isinstance(score, (int, float)) else None,
    )


def _build_harness():
    """Create a standalone AgentHarness for the eval run.

    Builds the full ReAct chat agent stack (RAGService + ToolRegistry +
    AgentRuntime + LangGraph chat agent) without requiring a FastAPI
    lifespan or a real DB session. ``EvalChatDeps`` short-circuits the
    DB-backed scope helpers — the eval feeds ``bvids`` directly via
    ``ChatAgentState`` so the agent never needs to resolve them from
    SQL.
    """

    from langchain_openai import ChatOpenAI

    from app.context import ContextManager
    from app.harness.app import AgentHarness
    from app.services.rag.legacy import RAGService

    rag = RAGService(api_key_manager=None)

    llm = ChatOpenAI(
        model=settings.llm_model,
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
        temperature=0,
        timeout=120,
    )

    harness = AgentHarness(
        context_manager=ContextManager(),
        llm=llm,
        session_factory=_eval_session_factory,
    )
    return rag, harness


class _EvalChatDeps:
    """ChatDeps stub for eval — no DB, scope is supplied by the caller."""

    def __init__(self, rag: Any) -> None:
        self._rag = rag

    async def get_media_ids(self, uid: int | None, folder_ids: list[int]) -> list[int]:
        return []

    async def get_bvids(self, media_ids: list[int]) -> list[str]:
        return []

    def has_cloud_backend(self) -> bool:
        return getattr(self._rag, "cloud_backend", None) is not None

    async def get_conversation_context(self, session_id: str) -> str:
        return ""

    async def get_video_context(
        self,
        media_ids: list[int],
        *,
        include_content: bool = False,
        limit: int | None = 50,
    ) -> tuple[str, list[dict]]:
        return "", []

    async def get_video_titles_context(self, media_ids: list[int]) -> str:
        return ""

    async def is_related_to_collection(
        self, media_ids: list[int], question: str
    ) -> bool:
        return True


class _NullSessionFactory:
    """Session factory placeholder — DBChatDeps registered but unused.

    The chat agent registration in AgentHarness gates on
    ``session_factory`` truthiness; we replace its DBChatDeps with
    ``_EvalChatDeps`` immediately after start() so SQL paths stay cold.
    """

    def __call__(self) -> Any:  # pragma: no cover — never invoked
        raise RuntimeError("eval session_factory should not be called")


_eval_session_factory = _NullSessionFactory()


def _swap_chat_deps_for_eval(harness: Any, rag: Any) -> None:
    """Replace the chat agent factory's ``deps`` kwarg with ``_EvalChatDeps``.

    The harness wires ``DBChatDeps`` into the chat factory at registration
    time. For eval we have no real DB, so we splice in a stub once the
    harness has finished registering everything.
    """
    factories = harness.lifecycle._factories  # noqa: SLF001 — eval-only splice
    if "chat" not in factories:
        raise RuntimeError("AgentHarness did not register a 'chat' agent")
    factory, kwargs = factories["chat"]
    factories["chat"] = (factory, {**kwargs, "deps": _EvalChatDeps(rag)})


async def _invoke_pipeline(
    sample: GoldenSample,
    rag,
    harness,
) -> tuple[str, list[RetrievedChunk], int, Optional[str]]:
    """Run the RAG pipeline for one sample.

    Returns (answer, retrieved_chunks, latency_ms, error_msg).
    """

    bvids = list(sample.must_contain_bvid) or None
    t0 = time.monotonic()

    # Direct retrieval — gives us the chunk list independent of the agent.
    # Retrieval metrics need chunk-level content/score, so we still call
    # ``rag.search`` here. The agent's own retrieval (via VectorSearchTool)
    # uses the same RAGService and produces the same candidates.
    try:
        docs = rag.search(sample.question, k=5, bvids=bvids)
    except Exception as exc:  # noqa: BLE001 — record, don't crash
        latency_ms = int((time.monotonic() - t0) * 1000)
        return "", [], latency_ms, f"search failed: {type(exc).__name__}: {exc}"

    retrieved = [_doc_to_chunk(d) for d in docs]

    # Generate the answer through the production AgentHarness so the ReAct
    # loop, prompts, and tool dispatch match the live chat path.
    try:
        result = await harness.dispatch(
            session_id=f"eval-{sample.qid}",
            query=sample.question,
            uid=None,
            bvids=list(bvids) if bvids else [],
            media_ids=[],
            workspace_pages=None,
            folder_ids=[],
        )
        answer = (result.get("result") or "").strip()
        if not answer and result.get("error"):
            return (
                "",
                retrieved,
                int((time.monotonic() - t0) * 1000),
                f"agent error: {result['error']}",
            )
    except Exception as exc:  # noqa: BLE001
        latency_ms = int((time.monotonic() - t0) * 1000)
        return "", retrieved, latency_ms, f"agent failed: {type(exc).__name__}: {exc}"

    latency_ms = int((time.monotonic() - t0) * 1000)
    return answer, retrieved, latency_ms, None


# ---------------------------------------------------------------------------
# Per-sample evaluation
# ---------------------------------------------------------------------------


async def _evaluate_one(
    sample: GoldenSample,
    rag,
    harness,
    *,
    dry_run: bool,
    judge_semaphore: asyncio.Semaphore,
) -> tuple[SampleResult, int]:
    """Run one sample end-to-end. Returns (result, judge_calls_made)."""

    answer, retrieved, latency_ms, pipeline_error = await _invoke_pipeline(
        sample, rag, harness
    )

    retrieved_bvids = [c.bvid for c in retrieved if c.bvid]

    recall = recall_at_k(retrieved_bvids, sample.must_contain_bvid, k=5)
    mrr = mrr_at_k(retrieved_bvids, sample.must_contain_bvid, k=5)
    precision_relevance = [
        1 if (c.bvid and c.bvid in sample.must_contain_bvid) else 0
        for c in retrieved
    ]
    precision = precision_at_k(precision_relevance, k=5)
    cit_acc = citation_accuracy(answer, retrieved_bvids)
    kw_rate = keyword_hit_rate(answer, sample.must_contain_keywords)
    neg_hits = negative_keyword_penalty(answer, sample.negative_keywords)

    # Judge
    judge_calls = 0
    judge_error: Optional[str] = pipeline_error
    if dry_run or pipeline_error:
        verdict = JudgeVerdict(
            score=0,
            hallucinated=False,
            reasoning="(skipped)",
            error=pipeline_error or "dry-run",
        )
    else:
        async with judge_semaphore:
            verdict = await judge_answer(
                question=sample.question,
                answer=answer,
                expected_points=sample.expected_answer_points,
                retrieved_chunks=tuple(retrieved),
            )
        judge_calls = 1
        if verdict.error:
            judge_error = verdict.error

    # Negative-keyword violation: cap quality at 1 and tag in reasoning
    final_score = verdict.score
    reasoning_text = verdict.reasoning
    if neg_hits > 0:
        final_score = min(final_score, 1)
        reasoning_text = (
            f"[negative_keyword_hit={neg_hits}] " + reasoning_text
        ).strip()

    sample_result = SampleResult(
        qid=sample.qid,
        category=sample.category,
        scope=sample.scope,
        recall_at_5=recall,
        precision_at_5=precision,
        mrr_at_5=mrr,
        answer_quality=final_score,
        citation_accuracy=cit_acc,
        keyword_hit_rate=kw_rate,
        latency_ms=latency_ms,
        retrieved=tuple(retrieved),
        answer=answer,
        judge_reasoning=reasoning_text,
        error=judge_error,
    )
    return sample_result, judge_calls


# ---------------------------------------------------------------------------
# CLI driver
# ---------------------------------------------------------------------------


def _git_sha() -> Optional[str]:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            stderr=subprocess.DEVNULL,
            cwd=str(EVAL_DIR),
        )
        return out.decode("ascii").strip() or None
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return None


def _config_snapshot() -> dict:
    return {
        "llm_model": settings.llm_model,
        "embedding_model": settings.embedding_model,
        "embedding_version": settings.embedding_version,
        "chunk_target_size": settings.chunk_target_size,
        "chunk_min_size": settings.chunk_min_size,
        "chunk_max_size": settings.chunk_max_size,
        "chunk_overlap": settings.chunk_overlap,
        "rerank_enabled": settings.rerank_enabled,
        "rerank_provider": settings.rerank_provider if settings.rerank_enabled else None,
        "rerank_model": settings.rerank_model if settings.rerank_enabled else None,
        "rerank_top_n": settings.rerank_top_n if settings.rerank_enabled else None,
    }


def _filter_samples(
    samples: list[GoldenSample],
    *,
    sample_limit: Optional[int],
    category: Optional[str],
    qid_prefix: Optional[str],
) -> list[GoldenSample]:
    filtered = samples
    if category:
        filtered = [s for s in filtered if s.category == category]
    if qid_prefix:
        filtered = [s for s in filtered if s.qid.startswith(qid_prefix)]
    if sample_limit and sample_limit > 0:
        filtered = filtered[:sample_limit]
    return filtered


async def _run_async(args: argparse.Namespace) -> Path:
    if not GOLDEN_PATH.exists():
        raise SystemExit(
            f"golden_set.jsonl not found at {GOLDEN_PATH} — write samples first"
        )

    all_samples = load_golden_set(GOLDEN_PATH)
    problems = validate_golden_set(all_samples)
    if problems:
        for p in problems:
            logger.error("[EVAL] golden_set problem: {}", p)
        raise SystemExit(f"golden_set has {len(problems)} validation problems")

    samples = _filter_samples(
        all_samples,
        sample_limit=args.samples,
        category=args.category,
        qid_prefix=args.qid_prefix,
    )
    if not samples:
        raise SystemExit("no samples left after filters")

    logger.info(
        "[EVAL] running tag={} samples={}/{} dry_run={}",
        args.tag, len(samples), len(all_samples), args.dry_run,
    )

    # Eval runs standalone (no FastAPI lifespan), so the infrastructure
    # connections that production startup wires up are not established.
    # Milvus needs an explicit connections.connect() before any
    # MilvusVectorStore or utility.has_collection() call — otherwise we
    # get ConnectionNotExistException at RAGService init.
    from app.infra import milvus as milvus_infra

    await milvus_infra.init()

    rag, harness = _build_harness()
    await harness.start()
    _swap_chat_deps_for_eval(harness, rag)
    judge_sem = asyncio.Semaphore(max(1, args.concurrency))

    started_at = datetime.now(timezone.utc)
    t0 = time.monotonic()

    results: list[SampleResult] = []
    total_judge_calls = 0
    for sample in samples:
        try:
            result, judge_calls = await _evaluate_one(
                sample,
                rag,
                harness,
                dry_run=args.dry_run,
                judge_semaphore=judge_sem,
            )
        except Exception as exc:  # noqa: BLE001 — never abort the whole run
            logger.exception("[EVAL] sample {} crashed: {}", sample.qid, exc)
            result = SampleResult(
                qid=sample.qid,
                category=sample.category,
                scope=sample.scope,
                recall_at_5=0.0,
                precision_at_5=0.0,
                mrr_at_5=0.0,
                answer_quality=0,
                citation_accuracy=0.0,
                keyword_hit_rate=0.0,
                latency_ms=0,
                retrieved=(),
                answer="",
                judge_reasoning="",
                error=f"runner crash: {type(exc).__name__}: {exc}",
            )
            judge_calls = 0
        results.append(result)
        total_judge_calls += judge_calls
        logger.info(
            "[EVAL] {}: recall@5={:.2f} mrr@5={:.2f} precision@5={:.2f} quality={} latency={}ms",
            result.qid,
            result.recall_at_5,
            result.mrr_at_5,
            result.precision_at_5,
            result.answer_quality,
            result.latency_ms,
        )

    duration_sec = time.monotonic() - t0
    summary = aggregate(results)

    run_id = f"{args.tag}_{started_at.strftime('%Y%m%d_%H%M')}"
    meta = RunMeta(
        run_id=run_id,
        git_sha=_git_sha(),
        tag=args.tag,
        started_at=started_at.isoformat(),
        duration_sec=duration_sec,
        sample_count=len(results),
        embedding_model=settings.embedding_model,
        llm_model=settings.llm_model,
        judge_model=settings.eval_llm_model,
        total_judge_calls=total_judge_calls,
        config_snapshot=_config_snapshot(),
    )
    report = RunReport(meta=meta, summary=summary, samples=tuple(results))

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    json_path = write_report(report, REPORTS_DIR)
    logger.info("[EVAL] report written to {}", json_path)

    # Best-effort cleanup so the script exits without lingering Milvus
    # gRPC channels / pymilvus warnings. Failures here are not fatal.
    try:
        await harness.shutdown()
    except Exception as exc:  # noqa: BLE001
        logger.debug("[EVAL] harness shutdown skipped: {}", type(exc).__name__)
    try:
        await milvus_infra.close()
    except Exception as exc:  # noqa: BLE001
        logger.debug("[EVAL] milvus close skipped: {}", type(exc).__name__)

    return json_path


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="app.test.eval.runner")
    parser.add_argument("--tag", required=True, help="report label, e.g. baseline")
    parser.add_argument("--samples", type=int, default=0, help="limit N samples (0 = all)")
    parser.add_argument("--category", default=None, help="filter by category")
    parser.add_argument("--qid-prefix", default=None, help="filter by qid prefix")
    parser.add_argument("--concurrency", type=int, default=2, help="judge call concurrency")
    parser.add_argument("--dry-run", action="store_true", help="skip judge LLM calls")
    args = parser.parse_args(argv)

    try:
        asyncio.run(_run_async(args))
    except SystemExit:
        raise
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001
        logger.exception("[EVAL] run aborted: {}", exc)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
