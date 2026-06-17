"""SearchChatHistoryTool — full-text grep across MongoDB history."""

from __future__ import annotations

import logging
from typing import Any, Optional

from app.context.compressor import (
    ConversationCompressor,
    LlmInvoke,
    SummarizeFn,
    TurnThreshold,
    build_summarize_fn,
)
from app.context.manager import ContextManager
from app.context.retriever import ContextRetriever, build_context_injection
from app.tools import ToolDeps, register_tool
from app.tools.context._utils import messages_to_text, query_to_pattern

logger = logging.getLogger(__name__)


@register_tool
class SearchChatHistoryTool:
    """Search past conversation history for messages matching a topic query.

    Uses MongoDB `$regex` matching via ``ContextRetriever``.  When an LLM
    summarizer is configured, old results are compressed into a structured
    summary; otherwise raw matching messages are returned.
    """

    def __init__(
        self,
        context_manager: ContextManager,
        llm_invoke: Optional[LlmInvoke] = None,
        *,
        max_recent_turns: int = 10,
        compress_threshold_turns: int = 25,
        cooldown_turns: int = 10,
    ) -> None:
        self._retriever = ContextRetriever()
        self._context_manager = context_manager

        self._summarize_fn: Optional[SummarizeFn] = None
        if llm_invoke is not None:
            self._summarize_fn = build_summarize_fn(llm_invoke)

        self._compressor = ConversationCompressor(
            max_recent_turns=max_recent_turns,
            trigger=TurnThreshold(
                max_turns=compress_threshold_turns,
                cooldown_turns=cooldown_turns,
            ),
        )

    @classmethod
    def from_deps(cls, deps: ToolDeps) -> "SearchChatHistoryTool | None":
        if deps.ctx_mgr is None:
            return None
        llm_invoke = getattr(deps.llm, "ainvoke", None) if deps.llm is not None else None
        return cls(deps.ctx_mgr, llm_invoke=llm_invoke)

    @property
    def name(self) -> str:
        return "search_chat_history"

    @property
    def description(self) -> str:
        return (
            "Search past conversation history for messages related to a topic. "
            "Use when you need to recall what was discussed earlier, "
            "especially when the user references something from before. "
            "The query is converted to keyword patterns and matched against "
            "the full conversation history."
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "chat_session_id": {
                    "type": "string",
                    "description": "The current chat session ID.",
                },
                "query": {
                    "type": "string",
                    "description": "What to search for in natural language.",
                },
            },
            "required": ["chat_session_id", "query"],
        }

    async def run(self, chat_session_id: str, query: str, **kwargs: Any) -> str:
        """Execute the search."""
        pattern = query_to_pattern(query)
        logger.info(
            "[CTX_TOOL] search_chat_history session=%s query=%s pattern=%s",
            chat_session_id,
            query[:80],
            pattern[:80],
        )

        if self._summarize_fn is not None:
            result = await self._retriever.retrieve_and_compress(
                chat_session_id,
                compressor=self._compressor,
                summarize_fn=self._summarize_fn,
                pattern=pattern,
            )
            text = build_context_injection(result)
            if text is None:
                return "未在历史对话中找到与查询相关的内容。"
            return text

        messages = await self._retriever.retrieve(
            chat_session_id,
            pattern=pattern,
        )
        if not messages:
            return "未在历史对话中找到与查询相关的内容。"
        return "【历史相关对话 — 原始记录】\n\n" + messages_to_text(messages)
