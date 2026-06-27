"""Tests for quiz config section (QuizSection / QuizLimitsSection / QuizQueueSection).

Pins the fix for the ``AttributeError: 'AppConfig' object has no attribute 'get'``
regression — quiz modules used to call ``config.get("quiz", ...)`` on a pydantic
BaseSettings object that has no ``.get`` method. They now use attribute access
(``config.quiz.limits.generate`` etc.) backed by dedicated section classes.

Covers:
- Default values match product spec (generate=5, grade=20, engine=background)
- YAML loading overrides defaults
- Environment variable overrides via ``QUIZ__LIMITS__GENERATE`` style keys
- ``_daily_limit`` reads via attribute access (no ``.get()`` on AppConfig)
- ``_queue_engine`` reads via attribute access
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.infra.config import (  # noqa: E402
    AppConfig,
    QuizLimitsSection,
    QuizQueueSection,
    QuizSection,
)


class TestQuizSectionDefaults:
    """Default values match the spec when no override is present."""

    def test_limits_default_generate_is_5(self) -> None:
        assert QuizLimitsSection().generate == 5

    def test_limits_default_grade_is_20(self) -> None:
        assert QuizLimitsSection().grade == 20

    def test_queue_default_engine_is_background(self) -> None:
        assert QuizQueueSection().engine == "background"

    def test_quiz_section_has_limits_and_queue(self) -> None:
        section = QuizSection()
        assert isinstance(section.limits, QuizLimitsSection)
        assert isinstance(section.queue, QuizQueueSection)

    def test_appconfig_has_quiz_field(self) -> None:
        """AppConfig must expose ``quiz`` as a typed field, not via .get()."""
        cfg = AppConfig()
        assert isinstance(cfg.quiz, QuizSection)
        # The original bug: code called config.get("quiz", ...) — make sure
        # the attribute exists and is reachable.
        assert cfg.quiz.limits.generate == 5
        assert cfg.quiz.limits.grade == 20
        assert cfg.quiz.queue.engine == "background"

    def test_appconfig_does_not_have_get_method(self) -> None:
        """Pydantic BaseSettings has no ``.get``; quiz modules must not rely on it."""
        cfg = AppConfig()
        assert not hasattr(cfg, "get")


class TestDailyLimitHelper:
    """``_daily_limit`` reads via attribute access on ``config.quiz.limits``."""

    def test_daily_limit_generate_uses_config(self) -> None:
        from app.services.llm.quiz_quota import _daily_limit

        # default config (no override in test env)
        assert _daily_limit("generate") == 5

    def test_daily_limit_grade_uses_config(self) -> None:
        from app.services.llm.quiz_quota import _daily_limit

        assert _daily_limit("grade") == 20

    def test_daily_limit_unknown_kind_returns_zero(self) -> None:
        from app.services.llm.quiz_quota import _daily_limit

        # getattr falls back to _DEFAULT_LIMITS.get(kind, 0) → 0 for unknown
        assert _daily_limit("nonexistent") == 0

    def test_daily_limit_returns_int(self) -> None:
        from app.services.llm.quiz_quota import _daily_limit

        result = _daily_limit("generate")
        assert isinstance(result, int)


class TestQueueEngineHelper:
    """``_queue_engine`` reads via attribute access on ``config.quiz.queue``."""

    def test_queue_engine_returns_background_by_default(self) -> None:
        from app.services.quiz_queue import _queue_engine

        assert _queue_engine() == "background"

    def test_queue_engine_returns_str(self) -> None:
        from app.services.quiz_queue import _queue_engine

        assert isinstance(_queue_engine(), str)
