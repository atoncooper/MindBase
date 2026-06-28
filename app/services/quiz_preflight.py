"""Preflight check for quiz generation.

Synchronously verifies that enough retrievable knowledge chunks exist before
creating a ``generating`` quiz row, so the user gets an immediate 400 instead
of waiting through a 30s poll for an inevitable failure.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from app.services.quiz_generator import QuizGeneratorService


@dataclass(frozen=True)
class PreflightResult:
    ok: bool
    reason: str


async def preflight_check(
    *,
    folder_ids: Optional[list[int]] = None,
    pages: Optional[list[dict]] = None,
    question_count: int = 10,
) -> PreflightResult:
    """Run chunk retrieval (no LLM) and verify the count meets the floor.

    Mirrors the min_chunks floor used by ``QuizGeneratorService.run_generation``:
    ``max(1, question_count // 5)``. Returns ``(ok, reason)`` where ``reason``
    is a user-readable Chinese message when ``ok=False``.
    """
    min_chunks = max(1, question_count // 5)
    service = QuizGeneratorService()
    count, empty_reason = await service.count_retrievable_chunks(
        folder_ids=folder_ids,
        pages=pages,
        question_count=question_count,
    )
    if count == 0:
        return PreflightResult(ok=False, reason=empty_reason)
    if count < min_chunks:
        return PreflightResult(
            ok=False,
            reason=(
                f"可用的知识片段不足（仅 {count} 段，至少需要 {min_chunks} 段），"
                "请先向量化更多视频或减少题目数量"
            ),
        )
    return PreflightResult(ok=True, reason="")
