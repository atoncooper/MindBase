"""Tests for the quiz batch system prompt — pins the singular-form type
constraint added to fix the ``single_choices`` discriminator rejection.

Context: the LLM occasionally emitted plural forms (``single_choices`` /
``multi_choices``) which pydantic's ``Literal`` discriminator rejected,
forcing a retry and burning quota. Since ``Literal`` does not support
aliases, the fix is a prompt-side constraint.

These tests verify the prompt text contains the singular-form rule so
regressions in prompt editing are caught.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.agent.quiz.prompts import (  # noqa: E402
    ESSAY_GRADING_PROMPT,
    ESSAY_GRADING_SYSTEM,
    QUIZ_BATCH_SYSTEM_PROMPT,
    QUIZ_BATCH_USER_PROMPT,
)


class TestQuizBatchSystemPromptSingularType:
    """The system prompt must instruct the LLM to emit singular type values."""

    def test_prompt_mentions_single_choice(self) -> None:
        assert "single_choice" in QUIZ_BATCH_SYSTEM_PROMPT

    def test_prompt_mentions_multi_choice(self) -> None:
        assert "multi_choice" in QUIZ_BATCH_SYSTEM_PROMPT

    def test_prompt_mentions_short_answer(self) -> None:
        assert "short_answer" in QUIZ_BATCH_SYSTEM_PROMPT

    def test_prompt_mentions_essay(self) -> None:
        assert "essay" in QUIZ_BATCH_SYSTEM_PROMPT

    def test_prompt_warns_against_plural_forms(self) -> None:
        """Prompt must explicitly call out the plural-form trap."""
        assert "single_choices" in QUIZ_BATCH_SYSTEM_PROMPT
        assert "复数" in QUIZ_BATCH_SYSTEM_PROMPT

    def test_prompt_states_consequence_of_plurals(self) -> None:
        """Prompt should explain that plural forms break structured parsing."""
        assert "结构化解析" in QUIZ_BATCH_SYSTEM_PROMPT or "解析失败" in QUIZ_BATCH_SYSTEM_PROMPT


class TestQuizBatchUserPromptChunks:
    """The user prompt must wrap knowledge context in untrusted tags."""

    def test_prompt_has_knowledge_context_placeholder(self) -> None:
        assert "{context}" in QUIZ_BATCH_USER_PROMPT

    def test_prompt_has_chunk_count_placeholder(self) -> None:
        assert "{chunk_count}" in QUIZ_BATCH_USER_PROMPT

    def test_prompt_has_total_count_placeholder(self) -> None:
        assert "{total_count}" in QUIZ_BATCH_USER_PROMPT

    def test_prompt_has_type_distribution_placeholder(self) -> None:
        assert "{type_distribution}" in QUIZ_BATCH_USER_PROMPT

    def test_prompt_has_difficulty_placeholder(self) -> None:
        assert "{difficulty}" in QUIZ_BATCH_USER_PROMPT

    def test_prompt_wraps_context_in_knowledge_context_tag(self) -> None:
        """Context must be wrapped so the LLM treats chunks as data, not instructions."""
        assert "<knowledge_context>" in QUIZ_BATCH_USER_PROMPT
        assert "</knowledge_context>" in QUIZ_BATCH_USER_PROMPT


class TestEssayGradingPromptIsolation:
    """Essay grading prompts must mark all user-supplied content as untrusted."""

    def test_system_prompt_declares_untrusted(self) -> None:
        assert "不可信" in ESSAY_GRADING_SYSTEM or "不得执行" in ESSAY_GRADING_SYSTEM

    def test_user_prompt_wraps_question_text(self) -> None:
        assert "<question_text>" in ESSAY_GRADING_PROMPT
        assert "{question_text}" in ESSAY_GRADING_PROMPT

    def test_user_prompt_wraps_scoring_rubric(self) -> None:
        assert "<scoring_rubric>" in ESSAY_GRADING_PROMPT
        assert "{scoring_rubric}" in ESSAY_GRADING_PROMPT

    def test_user_prompt_wraps_model_answer(self) -> None:
        assert "<model_answer>" in ESSAY_GRADING_PROMPT
        assert "{model_answer}" in ESSAY_GRADING_PROMPT

    def test_user_prompt_wraps_student_answer(self) -> None:
        assert "<student_answer>" in ESSAY_GRADING_PROMPT
        assert "{user_answer}" in ESSAY_GRADING_PROMPT

    def test_all_sections_declare_non_executable(self) -> None:
        """Each wrapped section must declare it is data, not instructions."""
        # At least 4 occurrences of the "不得执行" declaration
        assert ESSAY_GRADING_PROMPT.count("不得执行") >= 4


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
