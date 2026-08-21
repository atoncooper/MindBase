"""Tests for token-based context budgeting.

Covers:

- tokens.py: CJK-aware estimation (Chinese vs English density)
- TokenThreshold: fires on token overflow, respects min_turns and cooldown
- TokenBudgetWindow: trims to budget from the newest side, never splits a
  user+assistant pair, always keeps at least one message
"""

from __future__ import annotations

import pytest

from app.context import ConversationMessage
from app.context.tokens import (
    estimate_message_tokens,
    estimate_messages_tokens,
    estimate_tokens,
)
from app.context.compressor import TokenThreshold
from app.context.window import TokenBudgetWindow


def _turn(i: int, content: str = "") -> list[ConversationMessage]:
    body = content if content else f"问题{i}的较长内容" * 5
    return [
        ConversationMessage(role="user", content=f"q{i} {body}"),
        ConversationMessage(role="assistant", content=f"a{i} {body}"),
    ]


# ---------------------------------------------------------------------------
# estimator
# ---------------------------------------------------------------------------


class TestEstimator:
    def test_empty_is_zero(self):
        assert estimate_tokens("") == 0

    def test_chinese_denser_than_english(self):
        zh = estimate_tokens("你好世界再见")  # 5 CJK chars
        en = estimate_tokens("a b c d e")  # 9 non-CJK chars
        assert zh >= 3  # ~0.75/char
        assert en <= zh + 1  # english chars are ~4/token → cheap

    def test_never_returns_zero_for_nonempty(self):
        assert estimate_tokens("a") >= 1

    def test_message_overhead_added(self):
        bare = estimate_tokens("hi")
        msg = ConversationMessage(role="user", content="hi")
        assert estimate_message_tokens(msg) == bare + 4

    def test_list_sums(self):
        msgs = [
            ConversationMessage(role="user", content="abc"),
            ConversationMessage(role="assistant", content="def"),
        ]
        assert estimate_messages_tokens(msgs) == sum(
            estimate_message_tokens(m) for m in msgs
        )


# ---------------------------------------------------------------------------
# TokenThreshold
# ---------------------------------------------------------------------------


class TestTokenThreshold:
    def _cond(self, **kwargs) -> TokenThreshold:
        return TokenThreshold(max_tokens=100, min_turns=2, cooldown_turns=2, **kwargs)

    def test_below_budget_does_not_fire(self):
        cond = self._cond()
        msgs = _turn(1, "hi") + _turn(2, "hi")  # ~5 tokens/msg → 20 total
        assert estimate_messages_tokens(msgs) <= 100
        assert cond(msgs, None, 0, None) is False

    def test_fires_on_token_overflow(self):
        cond = self._cond()
        big = "内容" * 200  # ~300 CJK tokens per message
        msgs = _turn(1, big) + _turn(2, big) + _turn(3, big)
        assert estimate_messages_tokens(msgs) > 100
        assert cond(msgs, None, 0, None) is True

    def test_min_turns_blocks_single_giant_message(self):
        """Token overflow alone must not fire — a 1-turn conversation pays
        more for summarization than it saves."""
        cond = self._cond()
        msgs = [ConversationMessage(role="user", content="字" * 500)]
        assert estimate_messages_tokens(msgs) > 100
        assert cond(msgs, None, 0, None) is False

    def test_cooldown_blocks_after_first_compression(self):
        import time

        cond = self._cond()
        big = "内容" * 200
        msgs = _turn(1, big) + _turn(2, big) + _turn(3, big)
        now = time.time()
        # First compression already happened; only 1 turn since (< cooldown 2).
        assert cond(msgs, "prev", turns_since_last=1, last_compressed_at=now) is False
        # Cooldown elapsed → fires again.
        assert cond(msgs, "prev", turns_since_last=2, last_compressed_at=now) is True


# ---------------------------------------------------------------------------
# TokenBudgetWindow
# ---------------------------------------------------------------------------


class TestTokenBudgetWindow:
    def test_within_budget_returns_all(self):
        msgs = _turn(1) + _turn(2)
        win = TokenBudgetWindow(max_tokens=10_000)
        assert win.apply(msgs) == msgs

    def test_trims_from_oldest_side(self):
        msgs = _turn(1, "字" * 200) + _turn(2, "字" * 200) + _turn(3, "短")
        win = TokenBudgetWindow(max_tokens=150)
        kept = win.apply(msgs)
        assert len(kept) < len(msgs)
        # Newest messages survive; oldest are dropped.
        assert kept[-1].content.startswith("a3")
        total = sum(
            estimate_message_tokens(m) for m in kept
        )
        assert total <= 150 or len(kept) == 2  # budget held (or floor reached)

    def test_always_keeps_last_message_even_if_over_budget(self):
        huge = ConversationMessage(role="user", content="字" * 500)
        win = TokenBudgetWindow(max_tokens=10)
        kept = win.apply([huge])
        assert kept == [huge]

    def test_never_splits_user_assistant_pair(self):
        msgs = _turn(1, "字" * 100) + _turn(2, "字" * 100) + _turn(3, "字" * 100)
        win = TokenBudgetWindow(max_tokens=120)
        kept = win.apply(msgs)
        if 0 < len(kept) < len(msgs):
            # The first kept message must not be an assistant whose user
            # question was trimmed away.
            assert not (
                kept[0].role == "assistant"
                and msgs[len(msgs) - len(kept) - 1].role == "user"
            )

    def test_rejects_nonpositive_budget(self):
        with pytest.raises(ValueError):
            TokenBudgetWindow(max_tokens=0)
