"""Conversation context management module.

Provides:
    - In-memory conversation context per chat_session_id (with TTL)
    - MongoDB-backed persistence (optional, for multi-process deployments)
    - Sliding window truncation (default: last 20 turns)
    - Conversation compression via structured summarization (model-agnostic)
    - Context retrieval from MongoDB: recent N turns + grep pattern search
    - FastAPI dependency injection

Quick start::

    # 1. During app startup (main.py):
    from app.context import init_context_manager
    manager = init_context_manager()
    await manager.start_cleanup()
    app.state.context_manager = manager

    # 2. In a chat router:
    from app.context import (
        get_context_manager, ContextRetriever,
        ConversationCompressor, build_summarize_fn,
    )

    # Short-term memory (in-memory, auto-TTL)
    history = await ctx_manager.get_context(chat_session_id)

    # Long-term memory (MongoDB → compress → inject)
    retriever = ContextRetriever()
    result = await retriever.retrieve_and_compress(
        chat_session_id,
        compressor=compressor,
        summarize_fn=summarize,
        pattern="装饰器|闭包",    # grep for topic-relevant history
    )
    context_block = build_context_injection(result)
"""

from .cache import invalidate as invalidate_cache
from .compressor import (
    PREVIOUS_SUMMARY_SECTION,
    CompressionResult,
    CompressCondition,
    ConversationCompressor,
    LlmInvoke,
    SUMMARIZE_SYSTEM_PROMPT,
    SUMMARIZE_USER_TEMPLATE,
    SummarizeFn,
    TurnThreshold,
    build_summarize_fn,
)
from .config import ContextConfig, DEFAULT_CONFIG
from .dependency import get_context_manager, init_context_manager, reset_context_manager
from .manager import ContextManager
from .models import (
    ConversationContext,
    ConversationMessage,
    ConversationTurn,
    count_turns,
)
from .retriever import ContextRetriever, build_context_injection
from .store import ConversationStore, InMemoryStore
from .store_mongo import MongoStore
from .tools import create_context_tools
from .window import FixedSizeWindow, SlidingTurnWindow, WindowStrategy

__all__ = [
    # models
    "ConversationContext",
    "ConversationMessage",
    "ConversationTurn",
    "count_turns",
    # config
    "ContextConfig",
    "DEFAULT_CONFIG",
    # store
    "ConversationStore",
    "InMemoryStore",
    "MongoStore",
    # window
    "FixedSizeWindow",
    "SlidingTurnWindow",
    "WindowStrategy",
    # compressor
    "CompressCondition",
    "CompressionResult",
    "ConversationCompressor",
    "LlmInvoke",
    "PREVIOUS_SUMMARY_SECTION",
    "SUMMARIZE_SYSTEM_PROMPT",
    "SUMMARIZE_USER_TEMPLATE",
    "SummarizeFn",
    "TurnThreshold",
    "build_summarize_fn",
    # retriever
    "ContextRetriever",
    "build_context_injection",
    # manager
    "ContextManager",
    # cache
    "invalidate_cache",
    # di
    "get_context_manager",
    "init_context_manager",
    "reset_context_manager",
    # tools
    "create_context_tools",
]
