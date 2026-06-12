"""Conversation context data models."""

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal
import time

if TYPE_CHECKING:
    from .models import ConversationMessage


def count_turns(messages: list["ConversationMessage"]) -> int:
    """Count complete user+assistant turn pairs in a message list."""
    turns = 0
    i = 0
    while i < len(messages):
        if (
            messages[i].role == "user"
            and i + 1 < len(messages)
            and messages[i + 1].role == "assistant"
        ):
            turns += 1
            i += 2
        else:
            i += 1
    return turns


@dataclass
class ConversationMessage:
    """A single message in a conversation turn."""

    role: Literal["user", "assistant"]
    content: str
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {"role": self.role, "content": self.content}

    def to_langchain(self):
        """Convert to a LangChain message object."""
        if self.role == "user":
            from langchain_core.messages import HumanMessage

            return HumanMessage(content=self.content)
        else:
            from langchain_core.messages import AIMessage

            return AIMessage(content=self.content)


@dataclass
class ConversationTurn:
    """A complete turn: one user message + one assistant response."""

    user: ConversationMessage
    assistant: ConversationMessage | None = None

    @property
    def messages(self) -> list[ConversationMessage]:
        msgs = [self.user]
        if self.assistant is not None:
            msgs.append(self.assistant)
        return msgs


@dataclass
class ConversationContext:
    """Full context for a single chat session."""

    session_id: str
    messages: list[ConversationMessage] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    @property
    def turn_count(self) -> int:
        """Count complete turns (user+assistant pairs)."""
        return count_turns(self.messages)

    def touch(self) -> None:
        self.updated_at = time.time()
