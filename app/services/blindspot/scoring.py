"""Blind-spot map scoring pure functions (Plan 1.0.6).

No DB / LLM / network dependencies; unit-testable in isolation.
Quadrant rules: plan/1.0.6-BlindSpotMap/1.0.6-BlindSpotMap.md section 4.
"""

from __future__ import annotations

# Quadrant constants (public contract; frontend groups by these)
QUADRANT_DANGER = "danger"  # high exposure + many wrong answers: review first
QUADRANT_BLIND = "blind"  # seen often, never verified, never asked: false confidence
QUADRANT_LEARNING = "learning"  # user actively probed it: aware of the gap
QUADRANT_FAMILIAR = "familiar"  # verified with a high correct rate
QUADRANT_UNEXPLORED = "unexplored"  # passed by once, not really engaged

QUADRANTS = (
    QUADRANT_DANGER,
    QUADRANT_BLIND,
    QUADRANT_LEARNING,
    QUADRANT_FAMILIAR,
    QUADRANT_UNEXPLORED,
)

# Correct rate >= this threshold counts as mastered (when quiz data exists)
FAMILIAR_RATE_THRESHOLD = 0.7
# Exposure >= this and never verified -> blind (a single pass is unexplored)
BLIND_MIN_EXPOSURE = 2


def classify(
    *, exposure: int, quiz_total: int, correct_rate: float | None, probed: bool
) -> str:
    """Four signals -> one of five quadrants. None rate means no quiz data."""
    if quiz_total > 0:
        rate = correct_rate if correct_rate is not None else 0.0
        return QUADRANT_FAMILIAR if rate >= FAMILIAR_RATE_THRESHOLD else QUADRANT_DANGER
    if probed:
        return QUADRANT_LEARNING
    if exposure >= BLIND_MIN_EXPOSURE:
        return QUADRANT_BLIND
    if exposure >= 1:
        return QUADRANT_UNEXPLORED
    return QUADRANT_UNEXPLORED


def priority(exposure: int, quiz_correct: int, quiz_wrong: int) -> int:
    """Intra-quadrant rank: wider exposure and more mistakes rank higher;
    correct answers offset. Result is non-negative."""
    return max(0, exposure + 3 * quiz_wrong - quiz_correct)
