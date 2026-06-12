"""GetCompressedSummaryTool — reads pre-computed summary from Redis cache."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


class GetCompressedSummaryTool:
    """Get the compressed summary of past conversation from Redis cache.

    Faster than ``search_chat_history`` because it reads a pre-computed
    structured summary instead of scanning MongoDB.
    """

    @property
    def name(self) -> str:
        return "get_compressed_summary"

    @property
    def description(self) -> str:
        return (
            "Get the compressed summary of the entire conversation history "
            "from Redis cache. Faster than search_chat_history. "
            "Use when summarising past topics or key facts."
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "chat_session_id": {
                    "type": "string",
                    "description": "The current chat session ID.",
                },
            },
            "required": ["chat_session_id"],
        }

    async def run(self, chat_session_id: str, **kwargs: Any) -> str:
        from app.context.cache import get_cached

        logger.info("[CTX_TOOL] get_compressed_summary session=%s", chat_session_id)

        try:
            cached = await get_cached(chat_session_id)
            if cached is not None and cached.summary:
                return "【历史记忆 — Redis缓存】\n\n" + cached.summary
            return "未找到对话历史的压缩摘要。"
        except Exception as exc:
            logger.warning("[CTX_TOOL] get_compressed_summary failed: %s", exc)
            return "无法获取压缩摘要。"
