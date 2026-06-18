"""LLM-as-Judge for RAG answer quality.

Calls a dedicated judge model (default: ``gpt-4o-mini``) to score the
answer produced by the RAG pipeline against the golden expectations.
The judge is intentionally isolated from the system-under-test so that
co-trained biases don't inflate scores.

Configuration (env vars, all optional except api key):

    JUDGE__API_KEY   — required; falls back to OPENAI_API_KEY then LLM__API_KEY
    JUDGE__BASE_URL  — default: https://api.openai.com/v1
    JUDGE__MODEL     — default: settings.eval_llm_model (gpt-4o-mini)

The judge call is deterministic (temperature=0). Output is strict JSON;
on parse failure we retry once. A second failure returns score=0 with
an ``error`` field so the runner can record but not crash.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Optional, Sequence

from loguru import logger

from app.config import settings

from .schema import RetrievedChunk

_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


_RUBRIC = """You are a strict evaluator scoring a retrieval-augmented answer.

Score the answer on a 0-5 integer scale using this rubric:
  5 — Fully covers every expected point; no fabrications; cites grounded sources.
  4 — Covers the expected points with at most one minor omission; no fabrications.
  3 — Partially correct; covers some expected points but misses key facts OR
      contains a benign filler that does not contradict the source.
  2 — Mostly off-target; touches the topic but the core claim is wrong or absent.
  1 — Largely incorrect; major hallucination OR ignores the question entirely.
  0 — Completely wrong, refuses without reason, or empty.

Also flag whether the answer hallucinates content not supported by the
retrieved context (``hallucinated``: true/false). Hallucination should
LOWER the score even if expected points appear.

Output a SINGLE JSON object on a single line, no prose, no markdown:
  {"score": <0-5 integer>, "hallucinated": <bool>, "reasoning": "<<= 280 chars>"}
"""


@dataclass(frozen=True)
class JudgeVerdict:
    score: int
    hallucinated: bool
    reasoning: str
    error: Optional[str] = None


def _judge_credentials() -> tuple[str, str, str]:
    """Resolve (api_key, base_url, model) for the judge.

    Independent JUDGE__* env vars take priority so the judge can run
    against a different provider than the system under test.
    """

    api_key = (
        os.getenv("JUDGE__API_KEY")
        or os.getenv("OPENAI_API_KEY")
        or settings.openai_api_key
    )
    base_url = os.getenv("JUDGE__BASE_URL", "https://api.openai.com/v1")
    model = os.getenv("JUDGE__MODEL", settings.eval_llm_model)
    return api_key, base_url, model


def _build_user_prompt(
    question: str,
    answer: str,
    expected_points: Sequence[str],
    retrieved_chunks: Sequence[RetrievedChunk],
) -> str:
    expected_block = (
        "\n".join(f"- {p}" for p in expected_points) if expected_points else "(none)"
    )
    chunk_block_parts: list[str] = []
    for idx, chunk in enumerate(retrieved_chunks[:5], 1):
        title = chunk.title or "untitled"
        bvid = chunk.bvid or chunk.upload_uuid or "?"
        preview = (chunk.content_preview or "").strip()
        if len(preview) > 400:
            preview = preview[:400] + "…"
        chunk_block_parts.append(f"[{idx}] {title} ({bvid})\n{preview}")
    chunks_block = "\n\n".join(chunk_block_parts) or "(no chunks retrieved)"

    return (
        f"Question:\n{question}\n\n"
        f"Expected answer points:\n{expected_block}\n\n"
        f"Retrieved context:\n{chunks_block}\n\n"
        f"Candidate answer:\n{answer or '(empty)'}\n\n"
        "Score now."
    )


def _parse_verdict(raw: str) -> Optional[JudgeVerdict]:
    if not raw:
        return None
    match = _JSON_RE.search(raw)
    if not match:
        return None
    try:
        payload = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None

    score_val = payload.get("score")
    try:
        score = int(score_val)
    except (TypeError, ValueError):
        return None
    if not 0 <= score <= 5:
        return None

    hallucinated = bool(payload.get("hallucinated", False))
    reasoning = str(payload.get("reasoning") or "").strip()[:280]
    return JudgeVerdict(score=score, hallucinated=hallucinated, reasoning=reasoning)


async def judge_answer(
    question: str,
    answer: str,
    expected_points: Sequence[str],
    retrieved_chunks: Sequence[RetrievedChunk],
) -> JudgeVerdict:
    """Score the answer. Returns a verdict; never raises on LLM errors."""

    # Local import so the eval package stays importable without langchain
    # being installed (e.g., for unit tests on metrics.py alone).
    from langchain_core.messages import HumanMessage, SystemMessage
    from langchain_openai import ChatOpenAI

    api_key, base_url, model = _judge_credentials()
    if not api_key:
        return JudgeVerdict(
            score=0,
            hallucinated=False,
            reasoning="",
            error="missing JUDGE__API_KEY / OPENAI_API_KEY",
        )

    llm = ChatOpenAI(
        model=model,
        api_key=api_key,
        base_url=base_url,
        temperature=0,
        max_retries=0,  # we handle retry ourselves to record the reason
        timeout=60,
    )
    messages = [
        SystemMessage(content=_RUBRIC),
        HumanMessage(content=_build_user_prompt(
            question, answer, expected_points, retrieved_chunks
        )),
    ]

    last_error: Optional[str] = None
    for attempt in (1, 2):
        try:
            resp = await llm.ainvoke(messages)
        except Exception as exc:  # noqa: BLE001 — judge never crashes the run
            last_error = f"{type(exc).__name__}: {exc}"
            logger.warning("[EVAL.JUDGE] attempt=%d call failed: %s", attempt, exc)
            continue

        raw = str(getattr(resp, "content", "") or "")
        verdict = _parse_verdict(raw)
        if verdict is not None:
            return verdict

        last_error = f"unparseable judge output: {raw[:200]!r}"
        logger.warning("[EVAL.JUDGE] attempt=%d unparseable: %s", attempt, raw[:200])

    return JudgeVerdict(
        score=0,
        hallucinated=False,
        reasoning="",
        error=last_error or "judge failed without error",
    )
