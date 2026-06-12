"""GetFullHistoryTool — raw full conversation from MongoDB."""

from __future__ import annotations

import logging
from typing import Any

from app.context.retriever import ContextRetriever
from app.tools.context._utils import messages_to_text

logger = logging.getLogger(__name__)


class GetFullHistoryTool:
    """Get raw full conversation history from MongoDB.

    Slower than in-memory / Redis but has the complete history.
    """

    def __init__(self) -> None:
        self._retriever = ContextRetriever()

    @property
    def name(self) -> str:
        return "get_full_history"

    @property
    def description(self) -> str:
        return (
            "Get raw full conversation history from MongoDB. "
            "Use when the in-memory recent window is too short, "
            "or you need exact wording of past messages."
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "chat_session_id": {
                    "type": "string",
                    "description": "The current chat session ID.",
                },
                "n_messages": {
                    "type": "integer",
                    "description": "Number of recent messages to fetch (default: 50, max: 500).",
                },
            },
            "required": ["chat_session_id"],
        }

    async def run(
        self,
        chat_session_id: str,
        n_messages: int = 50,
        **kwargs: Any,
    ) -> str:
        n = min(max(n_messages, 1), 500)  # Clamp to [1, 500]
        logger.info("[CTX_TOOL] get_full_history session=%s n=%s", chat_session_id, n)

        try:
            messages = await self._retriever.get_recent_messages(chat_session_id, n)
            if not messages:
                return "未在数据库中找到对话记录。"
            return "【完整历史记录 — MongoDB】\n\n" + messages_to_text(messages)
        except Exception as exc:
            logger.warning("[CTX_TOOL] get_full_history failed: %s", exc)
            return "无法获取完整历史记录。"
