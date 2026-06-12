"""GetRecentContextTool — fastest, from in-memory storage."""

from __future__ import annotations

import logging
from typing import Any

from app.context.manager import ContextManager
from app.tools.context._utils import messages_to_text

logger = logging.getLogger(__name__)


class GetRecentContextTool:
    """Get the most recent conversation messages from in-memory storage.

    Fastest retrieval option — no database query needed.
    """

    def __init__(self, context_manager: ContextManager) -> None:
        self._context_manager = context_manager

    @property
    def name(self) -> str:
        return "get_recent_context"

    @property
    def description(self) -> str:
        return (
            "Get the most recent conversation messages from in-memory storage. "
            "Fast — use this when you only need the latest few turns."
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
                    "description": "Number of recent messages to return (default: 20).",
                },
            },
            "required": ["chat_session_id"],
        }

    async def run(
        self,
        chat_session_id: str,
        n_messages: int = 20,
        **kwargs: Any,
    ) -> str:
        all_messages = await self._context_manager.get_context_raw(chat_session_id)
        if not all_messages:
            return "当前会话尚无对话记录。"

        n = min(max(n_messages, 1), 500)  # Clamp to [1, 500]
        recent = all_messages[-n:]
        return "【最近对话记录 — 内存】\n\n" + messages_to_text(recent)
