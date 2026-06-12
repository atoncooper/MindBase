"""Shared helpers for context tools."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.context.models import ConversationMessage


def query_to_pattern(query: str) -> str:
    """Convert a natural-language query to a regex pattern for MongoDB $regex."""
    tokens = re.split(r"[，。！？、\s,!.?:;]+", query)
    keywords = [t.strip() for t in tokens if len(t.strip()) >= 2]
    if not keywords:
        return re.escape(query)
    return "|".join(re.escape(k) for k in keywords)


def messages_to_text(messages: list[ConversationMessage]) -> str:
    """Format a message list as readable dialogue text."""
    if not messages:
        return "（无最近对话记录）"
    lines: list[str] = []
    for m in messages:
        role = "用户" if m.role == "user" else "助手"
        content = m.content.replace("\n", " ").strip()
        if len(content) > 600:
            content = content[:600] + "…"
        lines.append(f"{role}：{content}")
    return "\n\n".join(lines)
