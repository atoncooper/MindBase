"""LangGraph-compatible tools for conversation context retrieval.

Provides tools that an LLM agent can call to search and retrieve
conversation history during multi-turn interactions.

Usage in a LangGraph agent::

    from langgraph.prebuilt import ToolNode
    from app.context.tools import create_context_tools

    tools = create_context_tools(context_manager=manager, llm_invoke=llm.ainvoke)
    tool_node = ToolNode(tools)

    # Bind to LLM for tool calling
    llm_with_tools = llm.bind_tools(tools)

    # In the graph definition
    graph.add_node("tools", tool_node)
    graph.add_conditional_edges("agent", router, {"tools": "tools", ...})
"""

from __future__ import annotations

import logging
import re
from typing import Optional

from langchain_core.tools import tool

from .compressor import (
    ConversationCompressor,
    LlmInvoke,
    SummarizeFn,
    TurnThreshold,
    build_summarize_fn,
)
from .manager import ContextManager
from .models import ConversationMessage
from .retriever import ContextRetriever, build_context_injection

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _query_to_pattern(query: str) -> str:
    """Convert a natural-language query to a regex pattern for MongoDB $regex.

    Splits on Chinese/English punctuation and whitespace, keeps tokens
    of length >= 2, and joins them with ``|``.
    """
    tokens = re.split(r"[，。！？、\s,!.?:;]+", query)
    keywords = [t.strip() for t in tokens if len(t.strip()) >= 2]
    if not keywords:
        return re.escape(query)
    return "|".join(re.escape(k) for k in keywords)


def _messages_to_text(messages: list[ConversationMessage]) -> str:
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


# ---------------------------------------------------------------------------
# factory
# ---------------------------------------------------------------------------


def create_context_tools(
    context_manager: ContextManager,
    llm_invoke: Optional[LlmInvoke] = None,
    *,
    max_recent_turns: int = 10,
    compress_threshold_turns: int = 25,
    cooldown_turns: int = 10,
) -> list:
    """Create LangGraph-compatible tools for conversation context retrieval.

    Returns a list of tools that can be passed to ``ToolNode`` or
    ``llm.bind_tools()``.  The tools capture *context_manager* (and
    optionally *llm_invoke*) via closure so no global state is needed.

    Args:
        context_manager: The singleton ``ContextManager`` instance.
        llm_invoke: Async callable ``([{role, content}, ...]) -> str`` for
                    LLM-powered summarization.  If omitted the heavy search
                    tool returns raw matching messages without compression.
        max_recent_turns: Turns kept verbatim after compression.
        compress_threshold_turns: Total turns that trigger compression.
        cooldown_turns: Minimum turns between two compressions.

    Returns:
        List of two tools: ``search_chat_history``, ``get_recent_context``."""
    # -- build dependencies once, capture in closures --------------------------
    retriever = ContextRetriever()

    summarize_fn: Optional[SummarizeFn] = None
    if llm_invoke is not None:
        summarize_fn = build_summarize_fn(llm_invoke)

    compressor = ConversationCompressor(
        max_recent_turns=max_recent_turns,
        trigger=TurnThreshold(
            max_turns=compress_threshold_turns, cooldown_turns=cooldown_turns
        ),
    )

    # -- tool definitions -----------------------------------------------------

    @tool
    async def search_chat_history(
        chat_session_id: str,
        query: str,
    ) -> str:
        """Search past conversation history for messages related to a topic.

        Use this tool when you need to recall what was discussed earlier,
        especially when:
        - The user references something from before (\"之前聊过的…\", \"上次提到…\")
        - You need to find specific facts, decisions, or entities from past turns
        - The user asks about a topic that may have been discussed many turns ago

        The query is converted to keyword patterns and matched against the full
        conversation history.  When compression is available old messages are
        summarised; otherwise raw matching messages are returned.

        Args:
            chat_session_id: The current chat session ID.
            query: What to search for in natural language.
                   Examples: \"Python装饰器\", \"数据库选型讨论\"

        Returns:
            A formatted context block with relevant history, or a note that
            nothing was found.
        """
        pattern = _query_to_pattern(query)
        logger.info(
            "[CTX_TOOL] search_chat_history session=%s query=%s pattern=%s",
            chat_session_id,
            query[:80],
            pattern[:80],
        )

        if summarize_fn is not None:
            # Heavy path: Mongo grep → compress → formatted context
            result = await retriever.retrieve_and_compress(
                chat_session_id,
                compressor=compressor,
                summarize_fn=summarize_fn,
                pattern=pattern,
            )
            text = build_context_injection(result)
            if text is None:
                return "未在历史对话中找到与查询相关的内容。"
            return text
        else:
            # Light path: Mongo grep only, no LLM summarisation
            messages = await retriever.retrieve(
                chat_session_id,
                pattern=pattern,
            )
            if not messages:
                return "未在历史对话中找到与查询相关的内容。"
            return "【历史相关对话 — 原始记录】\n\n" + _messages_to_text(messages)

    @tool
    async def get_compressed_summary(
        chat_session_id: str,
    ) -> str:
        """Get the compressed summary of past conversation from Redis cache.

        Use this tool when:
        - You need a quick summary of the ENTIRE conversation history
        - The user asks \"总结一下之前的对话\" or \"之前聊了什么\"
        - You want to understand the overall topic and key facts from history

        This is faster than search_chat_history because it reads a pre-computed
        summary from Redis instead of scanning MongoDB and running LLM compression.

        Args:
            chat_session_id: The current chat session ID.

        Returns:
            A structured summary of past conversation history, or a message
            indicating no summary is available.
        """
        from .cache import get_cached

        logger.info("[CTX_TOOL] get_compressed_summary session=%s", chat_session_id)

        try:
            cached = await get_cached(chat_session_id)
            if cached is not None and cached.summary:
                summary = cached.summary
                prefix = "【历史记忆 — Redis缓存】\n\n"
                return prefix + summary
            return "未找到对话历史的压缩摘要。"
        except Exception as exc:
            logger.warning("[CTX_TOOL] get_compressed_summary failed: %s", exc)
            return "无法获取压缩摘要。"

    @tool
    async def get_full_history(
        chat_session_id: str,
        n_messages: int = 50,
    ) -> str:
        """Get raw full conversation history from MongoDB.

        Use this tool when:
        - The in-memory recent window is too short and you need more messages
        - You need the exact wording of past messages (not a summary)
        - You need to find details from the entire conversation, not just a topic

        This fetches messages from MongoDB, which has the complete history but is
        slower than in-memory.

        Args:
            chat_session_id: The current chat session ID.
            n_messages: Number of recent messages to fetch (default: 50, max: 500).

        Returns:
            Recent conversation messages in chronological order.
        """
        n = min(n_messages, 500)
        logger.info("[CTX_TOOL] get_full_history session=%s n=%s", chat_session_id, n)

        try:
            messages = await retriever.get_recent_messages(chat_session_id, n)
            if not messages:
                return "未在数据库中找到对话记录。"
            return "【完整历史记录 — MongoDB】\n\n" + _messages_to_text(messages)
        except Exception as exc:
            logger.warning("[CTX_TOOL] get_full_history failed: %s", exc)
            return "无法获取完整历史记录。"

    @tool
    async def get_recent_context(
        chat_session_id: str,
        n_messages: int = 20,
    ) -> str:
        """Get the most recent conversation messages from in-memory storage.

        Use this tool to quickly check what was just discussed.  This is fast
        (in-memory, no database query) and should be preferred when you only
        need the latest few turns.

        Args:
            chat_session_id: The current chat session ID.
            n_messages: Number of recent messages to return (default: 20).

        Returns:
            The recent conversation as formatted dialogue text, or a note
            that no context exists yet.
        """
        all_messages = await context_manager.get_context_raw(chat_session_id)
        if not all_messages:
            return "当前会话尚无对话记录。"

        recent = all_messages[-n_messages:] if n_messages > 0 else all_messages
        return "【最近对话记录 — 内存】\n\n" + _messages_to_text(recent)

    return [
        search_chat_history,
        get_compressed_summary,
        get_full_history,
        get_recent_context,
    ]
