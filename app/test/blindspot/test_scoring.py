"""Blind-spot map scoring pure-function tests (Plan 1.0.6). No DB/network."""

import pytest

from app.services.blindspot.attribution import EntityAttributor
from app.services.blindspot.scoring import (
    BLIND_MIN_EXPOSURE,
    FAMILIAR_RATE_THRESHOLD,
    QUADRANT_BLIND,
    QUADRANT_DANGER,
    QUADRANT_FAMILIAR,
    QUADRANT_LEARNING,
    QUADRANT_UNEXPLORED,
    classify,
    priority,
)


class TestClassify:
    def test_high_correct_rate_is_familiar(self):
        assert (
            classify(exposure=5, quiz_total=10, correct_rate=0.9, probed=False)
            == QUADRANT_FAMILIAR
        )

    def test_rate_exactly_at_threshold_is_familiar(self):
        assert (
            classify(
                exposure=3, quiz_total=10, correct_rate=FAMILIAR_RATE_THRESHOLD,
                probed=False,
            )
            == QUADRANT_FAMILIAR
        )

    def test_low_correct_rate_is_danger(self):
        assert (
            classify(exposure=4, quiz_total=6, correct_rate=0.33, probed=False)
            == QUADRANT_DANGER
        )

    def test_all_wrong_is_danger(self):
        assert (
            classify(exposure=1, quiz_total=2, correct_rate=0.0, probed=True)
            == QUADRANT_DANGER
        )

    def test_quiz_data_overrides_probed_signal(self):
        # Verification data overrides the probing signal
        assert (
            classify(exposure=2, quiz_total=1, correct_rate=0.0, probed=True)
            == QUADRANT_DANGER
        )

    def test_probed_without_quiz_is_learning(self):
        assert (
            classify(exposure=5, quiz_total=0, correct_rate=None, probed=True)
            == QUADRANT_LEARNING
        )

    def test_multi_exposure_unverified_is_blind(self):
        assert (
            classify(
                exposure=BLIND_MIN_EXPOSURE, quiz_total=0, correct_rate=None,
                probed=False,
            )
            == QUADRANT_BLIND
        )

    def test_single_exposure_unverified_is_unexplored(self):
        assert (
            classify(exposure=1, quiz_total=0, correct_rate=None, probed=False)
            == QUADRANT_UNEXPLORED
        )

    def test_zero_everything_is_unexplored(self):
        assert (
            classify(exposure=0, quiz_total=0, correct_rate=None, probed=False)
            == QUADRANT_UNEXPLORED
        )


class TestPriority:
    def test_wrong_outweighs_correct(self):
        # one wrong answer (3 pts) outweighs one correct answer (1 pt)
        assert priority(0, quiz_correct=1, quiz_wrong=1) == 2
        assert priority(0, quiz_correct=2, quiz_wrong=1) == 1

    def test_never_negative(self):
        assert priority(0, quiz_correct=10, quiz_wrong=0) == 0

    def test_exposure_adds_base_priority(self):
        assert priority(5, quiz_correct=0, quiz_wrong=0) == 5


class TestEntityAttributor:
    @pytest.mark.asyncio
    async def test_no_index_returns_empty(self):
        attributor = EntityAttributor(None)
        assert attributor.available is False
        assert await attributor.attribute("什么是 RAG") == []

    @pytest.mark.asyncio
    async def test_threshold_filters_low_score_hits(self):
        class FakeIndex:
            def search(self, text, top_n=3):
                return [
                    {"eid": "1", "name": "RAG", "score": 0.9},
                    {"eid": "2", "name": "Milvus", "score": 0.5},
                    {"eid": "3", "name": "", "score": 0.99},
                ]

        attributor = EntityAttributor(FakeIndex())
        names = await attributor.attribute("RAG 检索增强的原理")
        assert names == ["RAG"]

    @pytest.mark.asyncio
    async def test_blank_text_short_circuits(self):
        class ExplodingIndex:
            def search(self, *_a, **_k):  # pragma: no cover
                raise AssertionError("should not be called")

        attributor = EntityAttributor(ExplodingIndex())
        assert await attributor.attribute("   ") == []
