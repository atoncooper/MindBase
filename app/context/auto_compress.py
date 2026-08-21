"""Auto-compression wiring — the link between the live chat path and the
ConversationCompressor pipeline.

Flow per completed chat turn (fire-and-forget, never blocks the response)::

    record_turn()                        (orchestrator, after finalize_turn)
      └─ background task:
           1. ContextManager.add_turn()           ← raw history accumulates
           2. ConversationCompressor.compress()   ← TokenThreshold(budget)
                 ├─ not triggered → done
                 └─ triggered:
                      summarize(old turns)          → structured summary (LLM)
                      ContextManager.replace_all()  → store trimmed to recent window
                      cache.set_cached(summary)     → Redis mirror

Triggering is TOKEN-based (``TokenThreshold``): cost/latency/window all
accrue in tokens and a "turn" ranges from 50 to 10k+ tokens of tool output,
so turn counts control the wrong variable.  ``min_turns`` keeps very short
conversations from paying for a summarization call they don't need yet.

Read path: ``db_deps.get_conversation_context`` injects the cached summary
(if any) above the raw last-3-turns block, so the model sees "compressed
memory of old turns + verbatim recent turns".

State & continuity: per-session ``ConversationCompressor`` instances keep
the accumulated summary in-process; the Redis cache mirrors it so a restart
can seed a fresh compressor via ``restore()`` without losing memory
continuity.  With Redis unavailable the pipeline still compresses — only
the cross-restart mirror and the read-path injection degrade (graceful:
behaves like no compression).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .cache import get_cached, set_cached
from .compressor import (
    ConversationCompressor,
    LlmInvoke,
    SummarizeFn,
    TokenThreshold,
    build_summarize_fn,
)
from .manager import ContextManager

logger = logging.getLogger(__name__)

# Fraction of the model's context window usable for conversation history.
# The rest is headroom for system prompt, tool schemas, retrieval results and
# the response itself.  The budget scales with the ACTIVE model's window
# (``llm.context_window``): a 128k model compresses around 64k of history, a
# 1M model around 500k — compression stays dormant on big-window models
# instead of throwing away memory they could have used.
HISTORY_BUDGET_RATIO = 0.5
_MIN_TOKEN_BUDGET = 4000


def _default_token_budget() -> int:
    """Derive the history token budget from the active model's context window.

    The window comes from the built-in model registry
    (``resolve_context_window``) so switching models — including via the
    OpenRouter provider — re-scales the compression threshold automatically;
    no manual pinning unless the model is unknown.
    """
    from app.config import settings
    from app.services.llm.providers import resolve_context_window

    window = resolve_context_window(
        settings.llm_model, settings.llm_context_window
    )
    return max(_MIN_TOKEN_BUDGET, int(window * HISTORY_BUDGET_RATIO))

# Module-level singleton (mirrors dependency.py's ContextManager pattern).
_registry: "SessionCompressorRegistry | None" = None


def _llm_to_invoke(llm: Any) -> LlmInvoke:
    """Adapt a LangChain chat model to the compressor's ``LlmInvoke`` protocol."""

    async def _invoke(messages: list[dict[str, str]]) -> str:
        resp = await llm.ainvoke(messages)
        content = getattr(resp, "content", resp)
        return content if isinstance(content, str) else str(content)

    return _invoke


class SessionCompressorRegistry:
    """Per-session compressor state + background compression scheduling.

    ``record_turn`` is the sync entry point called by the orchestrator after
    a turn is persisted; it schedules the actual work as a task so the HTTP
    response is never delayed by compression.
    """

    def __init__(
        self,
        context_manager: ContextManager,
        llm: Any = None,
        summarize_fn: SummarizeFn | None = None,
        *,
        max_recent_turns: int = 10,
        token_budget: int | None = None,
        min_turns: int = 4,
        cooldown_turns: int = 10,
    ) -> None:
        self._cm = context_manager
        if summarize_fn is None:
            if llm is None:
                raise ValueError("auto-compressor requires llm or summarize_fn")
            summarize_fn = build_summarize_fn(_llm_to_invoke(llm))
        self._summarize_fn = summarize_fn
        self._max_recent_turns = max_recent_turns
        # None = derive per-use (window registry + vendor metadata), so a
        # dynamically-fetched context window takes effect without restart.
        self._explicit_budget = token_budget
        self._min_turns = min_turns
        self._cooldown_turns = cooldown_turns
        self._compressors: dict[str, ConversationCompressor] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    @property
    def _token_budget(self) -> int:
        """Effective history token budget (explicit override or derived)."""
        if self._explicit_budget is not None:
            return self._explicit_budget
        return _default_token_budget()

    # -- entry point -----------------------------------------------------

    def record_turn(
        self, session_id: str, user_content: str, assistant_content: str
    ) -> None:
        """Record a completed turn and schedule a compression check.

        Sync + non-blocking: safe to call from request handlers.  Requires a
        running event loop (always true at the orchestrator call sites).
        """
        asyncio.get_running_loop().create_task(
            self._on_turn(session_id, user_content, assistant_content)
        )

    async def _on_turn(
        self, session_id: str, user_content: str, assistant_content: str
    ) -> None:
        try:
            await self._cm.add_turn(session_id, user_content, assistant_content)
            await self.maybe_compress(session_id)
        except Exception:
            logger.exception(
                "[CTX_AUTO] turn record failed session=%s", session_id
            )

    # -- compression -------------------------------------------------------

    async def maybe_compress(self, session_id: str) -> bool:
        """Run a condition-fired compression pass for one session.

        Returns True if a compression actually happened.  Serialized per
        session: load → compress → replace must be atomic against
        concurrent turns of the same conversation.
        """
        lock = self._locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            messages = await self._cm.get_context_raw(session_id)
            if not messages:
                return False

            compressor = self._compressors.get(session_id)
            budget = self._token_budget
            if compressor is None:
                compressor = ConversationCompressor(
                    max_recent_turns=self._max_recent_turns,
                    trigger=TokenThreshold(
                        max_tokens=budget,
                        min_turns=self._min_turns,
                        cooldown_turns=self._cooldown_turns,
                    ),
                )
                # Continuity across restarts: seed the accumulated summary
                # from the Redis mirror, if one exists.
                try:
                    cached = await get_cached(session_id)
                except Exception:
                    cached = None
                if cached and cached.summary:
                    compressor.restore(cached.summary)
                self._compressors[session_id] = compressor
            elif (
                isinstance(compressor.trigger, TokenThreshold)
                and compressor.trigger.max_tokens != budget
            ):
                # Budget moved (e.g. vendor context-window metadata arrived in
                # the background) — keep existing sessions in sync.
                compressor.trigger.max_tokens = budget

            result = await compressor.compress(messages, self._summarize_fn)
            if not result.did_compress:
                return False

            # Order matters: replace_all invalidates the cache key, so the
            # fresh summary must be stored AFTER the store is trimmed.
            await self._cm.replace_all(session_id, result.kept_messages)
            await set_cached(session_id, result)
            logger.info(
                "[CTX_AUTO] compressed session=%s absorbed_msgs=%s kept_msgs=%s "
                "summary_chars=%s",
                session_id,
                result.compressed_count,
                len(result.kept_messages),
                len(result.summary or ""),
            )
            return True

    # -- introspection / testing --------------------------------------------

    def compressor_for(self, session_id: str) -> ConversationCompressor | None:
        """Return the per-session compressor (None before the first turn)."""
        return self._compressors.get(session_id)

    async def reset_session(self, session_id: str) -> None:
        """Drop per-session compression state (e.g. the session was cleared)."""
        self._compressors.pop(session_id, None)


def init_auto_compressor(
    context_manager: ContextManager,
    llm: Any = None,
    summarize_fn: SummarizeFn | None = None,
    **kwargs: Any,
) -> SessionCompressorRegistry:
    """Create (or replace) the module-level registry.  Call during startup."""
    global _registry
    _registry = SessionCompressorRegistry(
        context_manager, llm=llm, summarize_fn=summarize_fn, **kwargs
    )
    _schedule_dynamic_window_refresh()
    return _registry


def _schedule_dynamic_window_refresh() -> None:
    """Best-effort: pull vendor-provided context_length metadata (OpenRouter
    ``/models``) in the background so compression budgets use authoritative
    numbers instead of the static fallback table.  No-op for providers whose
    /models endpoint lacks window metadata (e.g. DashScope)."""
    try:
        from app.config import settings as _settings
        from app.services.llm.providers import (
            refresh_dynamic_context_windows,
            resolve_llm_config,
        )

        if _settings.llm_provider != "openrouter":
            return
        cfg = resolve_llm_config()
        asyncio.get_running_loop().create_task(
            refresh_dynamic_context_windows(cfg.base_url, cfg.api_key)
        )
    except Exception:
        logger.warning(
            "[CTX_AUTO] dynamic context-window refresh not scheduled",
            exc_info=True,
        )


def get_auto_compressor() -> "SessionCompressorRegistry | None":
    """Return the registry, or None before initialisation (pipeline no-op)."""
    return _registry


def reset_auto_compressor() -> None:
    """Reset the singleton.  Intended for test teardown."""
    global _registry
    _registry = None
