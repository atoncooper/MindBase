"""Question-text -> entity attribution fallback (Plan 1.0.6, scheme B).

New questions are tagged at generation time via LLM structured output
(`related_entities`, scheme A — see quiz schemas/prompts). Legacy questions
without tags get attributed here: the question text is embedded and matched
against the Milvus entity index (KgEntityIndex), same linking source as
kg_search but with a more conservative threshold.
"""

from __future__ import annotations

import asyncio
from typing import Any

from loguru import logger

# Tighter than retrieval-time entity linking (config.kg.link_score_threshold):
# a wrong attribution costs more than a missed one (it would charge quiz
# mistakes to an unrelated concept). Kept as a constant on purpose.
ATTRIBUTION_SCORE_THRESHOLD = 0.75
_MAX_TEXT_CHARS = 500


class EntityAttributor:
    """Question attributor backed by KgEntityIndex. None index -> always []."""

    def __init__(self, index: Any | None):
        self._index = index

    @property
    def available(self) -> bool:
        return self._index is not None

    async def attribute(self, question_text: str, top_n: int = 3) -> list[str]:
        """Entity names linked from the question text (threshold-filtered)."""
        if self._index is None or not question_text.strip():
            return []
        text = question_text[:_MAX_TEXT_CHARS]
        try:
            hits = await asyncio.to_thread(self._index.search, text, top_n)
        except Exception as e:
            logger.warning("[BLINDSPOT] entity attribution search failed: {}", e)
            return []
        return [
            h["name"]
            for h in hits
            if h.get("name") and h.get("score", 0.0) >= ATTRIBUTION_SCORE_THRESHOLD
        ]
