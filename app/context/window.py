"""Sliding window strategies for conversation context truncation."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import ConversationMessage


class WindowStrategy(ABC):
    """Abstract strategy for trimming a message list to fit within a budget.

    Subclass to implement different budget models (turns, tokens, etc.).
    """

    @abstractmethod
    def apply(self, messages: list[ConversationMessage]) -> list[ConversationMessage]:
        """Return a trimmed copy of *messages* that fits the budget."""

    @property
    @abstractmethod
    def budget_description(self) -> str:
        """Human-readable description of the budget (for logging)."""


class SlidingTurnWindow(WindowStrategy):
    """Keep the last *max_turns* complete user+assistant pairs.

    A turn is defined as a consecutive (user, assistant) message pair.
    Unpaired messages at the end (e.g. a user message not yet answered)
    are preserved in addition to the turn budget.

    Example with max_turns=2:
        [u1, a1, u2, a2, u3, a3, u4]  →  [u3, a3, u4]
    """

    def __init__(self, max_turns: int) -> None:
        if max_turns < 1:
            raise ValueError("max_turns must be >= 1")
        self.max_turns = max_turns

    @property
    def budget_description(self) -> str:
        return f"max_turns={self.max_turns}"

    def apply(self, messages: list[ConversationMessage]) -> list[ConversationMessage]:
        if not messages:
            return []

        turns: list[tuple[ConversationMessage, ConversationMessage | None]] = []
        i = 0
        while i < len(messages):
            if (
                messages[i].role == "user"
                and i + 1 < len(messages)
                and messages[i + 1].role == "assistant"
            ):
                turns.append((messages[i], messages[i + 1]))
                i += 2
            else:
                turns.append((messages[i], None))
                i += 1

        # Determine which turns to keep
        if len(turns) <= self.max_turns:
            return list(messages)

        kept = turns[-self.max_turns :]
        result: list[ConversationMessage] = []
        for user_msg, assistant_msg in kept:
            result.append(user_msg)
            if assistant_msg is not None:
                result.append(assistant_msg)
        return result


class FixedSizeWindow(WindowStrategy):
    """Keep the last *max_messages* messages regardless of role pairing."""

    def __init__(self, max_messages: int) -> None:
        if max_messages < 1:
            raise ValueError("max_messages must be >= 1")
        self.max_messages = max_messages

    @property
    def budget_description(self) -> str:
        return f"max_messages={self.max_messages}"

    def apply(self, messages: list[ConversationMessage]) -> list[ConversationMessage]:
        if len(messages) <= self.max_messages:
            return list(messages)
        return messages[-self.max_messages :]


class TokenBudgetWindow(WindowStrategy):
    """Keep the newest messages whose cumulative estimated tokens fit the budget.

    Walks from the newest message backwards accumulating estimates and stops
    before exceeding *max_tokens* (at least the last message is always kept).
    The cut is adjusted so a user+assistant pair is never split — an orphan
    assistant message at the start of the kept window would answer a question
    that is no longer there.

    Token-based (not turn-based) because cost/latency/window all accrue in
    tokens; a "turn" can be 50 tokens of chat or 10k of tool output.
    """

    def __init__(self, max_tokens: int) -> None:
        if max_tokens < 1:
            raise ValueError("max_tokens must be >= 1")
        self.max_tokens = max_tokens

    @property
    def budget_description(self) -> str:
        return f"max_tokens={self.max_tokens}"

    def apply(self, messages: list[ConversationMessage]) -> list[ConversationMessage]:
        from .tokens import estimate_message_tokens

        if not messages:
            return []
        kept_estimate = 0
        cut = len(messages)  # index of the first KEPT message
        for i in range(len(messages) - 1, -1, -1):
            cost = estimate_message_tokens(messages[i])
            # Always keep at least the newest message, budget or not.
            if i != len(messages) - 1 and kept_estimate + cost > self.max_tokens:
                break
            kept_estimate += cost
            cut = i

        # Don't start the kept window on an orphan assistant message.
        if 0 < cut < len(messages) and messages[cut].role == "assistant":
            cut -= 1
        return list(messages[cut:])
