"""Tests for the ``app.context`` package.

Covers:

- Models: ConversationMessage, ConversationTurn, ConversationContext, count_turns
- Config: ContextConfig defaults
- Window strategies: SlidingTurnWindow, FixedSizeWindow
- In-Memory store: InMemoryStore (all public methods)
- Compression: TurnThreshold trigger, build_summarize_fn, ConversationCompressor
- ContextManager: all public API methods, lifecycle, cache invalidation
- Dependency injection: init_context_manager / reset_context_manager
- LangGraph tools: create_context_tools, search_chat_history, get_recent_context
"""

from __future__ import annotations

import time
from unittest.mock import AsyncMock

import pytest

from app.context import (
    ContextManager,
    ConversationCompressor,
    ConversationContext,
    ConversationMessage,
    ConversationTurn,
    FixedSizeWindow,
    InMemoryStore,
    SlidingTurnWindow,
    TurnThreshold,
    build_summarize_fn,
    ContextConfig,
    count_turns,
    create_context_tools,
)
from app.context.dependency import init_context_manager, reset_context_manager


# ===========================================================================
# Models
# ===========================================================================


class TestConversationMessage:
    def test_default_timestamp(self):
        before = time.time()
        msg = ConversationMessage(role="user", content="hello")
        after = time.time()
        assert before <= msg.timestamp <= after

    def test_to_dict(self):
        msg = ConversationMessage(role="user", content="hi", timestamp=100.0)
        assert msg.to_dict() == {"role": "user", "content": "hi"}

    def test_to_langchain_user(self):
        msg = ConversationMessage(role="user", content="hello", timestamp=1.0)
        lc = msg.to_langchain()
        assert type(lc).__name__ == "HumanMessage"
        assert lc.content == "hello"

    def test_to_langchain_assistant(self):
        msg = ConversationMessage(role="assistant", content="world", timestamp=1.0)
        lc = msg.to_langchain()
        assert type(lc).__name__ == "AIMessage"
        assert lc.content == "world"


class TestConversationTurn:
    def test_messages_with_assistant(self):
        user = ConversationMessage(role="user", content="u", timestamp=1.0)
        assistant = ConversationMessage(role="assistant", content="a", timestamp=2.0)
        turn = ConversationTurn(user=user, assistant=assistant)
        assert turn.messages == [user, assistant]

    def test_messages_without_assistant(self):
        user = ConversationMessage(role="user", content="u", timestamp=1.0)
        turn = ConversationTurn(user=user, assistant=None)
        assert turn.messages == [user]


class TestConversationContext:
    def test_empty_turn_count(self):
        ctx = ConversationContext(session_id="s1")
        assert ctx.turn_count == 0

    def test_turn_count_one_pair(self):
        ctx = ConversationContext(
            session_id="s1",
            messages=[
                ConversationMessage(role="user", content="u1", timestamp=1.0),
                ConversationMessage(role="assistant", content="a1", timestamp=2.0),
            ],
        )
        assert ctx.turn_count == 1

    def test_turn_count_multi(self):
        ctx = ConversationContext(
            session_id="s1",
            messages=[
                ConversationMessage(role="user", content="u1", timestamp=1.0),
                ConversationMessage(role="assistant", content="a1", timestamp=2.0),
                ConversationMessage(role="user", content="u2", timestamp=3.0),
                ConversationMessage(role="assistant", content="a2", timestamp=4.0),
                ConversationMessage(role="user", content="u3", timestamp=5.0),
            ],
        )
        assert ctx.turn_count == 2  # u3 is unpaired → not counted

    def test_touch_updates_updated_at(self):
        ctx = ConversationContext(session_id="s1", messages=[])
        before = ctx.updated_at
        time.sleep(0.01)
        ctx.touch()
        assert ctx.updated_at > before


class TestCountTurns:
    def test_empty(self):
        assert count_turns([]) == 0

    def test_only_user(self):
        msgs = [ConversationMessage(role="user", content="u", timestamp=1.0)]
        assert count_turns(msgs) == 0

    def test_one_pair(self):
        msgs = [
            ConversationMessage(role="user", content="u", timestamp=1.0),
            ConversationMessage(role="assistant", content="a", timestamp=2.0),
        ]
        assert count_turns(msgs) == 1

    def test_interleaved_multiple(self):
        """Pairs can start at any index."""
        msgs = [
            ConversationMessage(role="user", content="u1", timestamp=1.0),
            ConversationMessage(role="user", content="u2", timestamp=2.0),
            ConversationMessage(role="assistant", content="a1", timestamp=3.0),
        ]
        # (u2, a1) at indices 1,2 form one pair
        assert count_turns(msgs) == 1


# ===========================================================================
# Config
# ===========================================================================


class TestContextConfig:
    def test_defaults(self):
        cfg = ContextConfig()
        assert cfg.max_turns == 20
        assert cfg.max_messages == 0
        assert cfg.ttl_seconds == 900
        assert cfg.max_sessions == 10000
        assert cfg.cleanup_interval == 120

    def test_custom(self):
        cfg = ContextConfig(max_turns=10, ttl_seconds=300)
        assert cfg.max_turns == 10
        assert cfg.ttl_seconds == 300


# ===========================================================================
# Window strategies
# ===========================================================================


class TestSlidingTurnWindow:
    def test_empty(self):
        w = SlidingTurnWindow(max_turns=5)
        assert w.apply([]) == []

    def test_under_budget(self):
        w = SlidingTurnWindow(max_turns=5)
        msgs = [
            ConversationMessage(role="user", content="u1", timestamp=1.0),
            ConversationMessage(role="assistant", content="a1", timestamp=2.0),
        ]
        assert w.apply(msgs) == msgs

    def test_trim_exact(self):
        w = SlidingTurnWindow(max_turns=2)
        # 3 turns → keep last 2
        msgs = [
            ConversationMessage(role="user", content="u1", timestamp=1.0),
            ConversationMessage(role="assistant", content="a1", timestamp=2.0),
            ConversationMessage(role="user", content="u2", timestamp=3.0),
            ConversationMessage(role="assistant", content="a2", timestamp=4.0),
            ConversationMessage(role="user", content="u3", timestamp=5.0),
            ConversationMessage(role="assistant", content="a3", timestamp=6.0),
        ]
        kept = w.apply(msgs)
        assert len(kept) == 4
        assert kept[0].content == "u2"
        assert kept[-1].content == "a3"

    def test_preserves_unpaired_at_end(self):
        """Unpaired user messages at the end are counted as a 'partial turn'."""
        w = SlidingTurnWindow(max_turns=1)
        msgs = [
            ConversationMessage(role="user", content="u1", timestamp=1.0),
            ConversationMessage(role="assistant", content="a1", timestamp=2.0),
            ConversationMessage(role="user", content="u2", timestamp=3.0),
        ]
        # turns = [(u1,a1), (u2,None)], keep last 1 → [u2]
        kept = w.apply(msgs)
        assert len(kept) == 1
        assert kept[0].content == "u2"

    def test_raises_on_zero(self):
        with pytest.raises(ValueError, match="max_turns must be >= 1"):
            SlidingTurnWindow(max_turns=0)

    def test_budget_description(self):
        w = SlidingTurnWindow(max_turns=10)
        assert "max_turns=10" in w.budget_description


class TestFixedSizeWindow:
    def test_empty(self):
        w = FixedSizeWindow(max_messages=5)
        assert w.apply([]) == []

    def test_under_budget(self):
        w = FixedSizeWindow(max_messages=5)
        msgs = [
            ConversationMessage(role="user", content="u", timestamp=float(i))
            for i in range(3)
        ]
        assert w.apply(msgs) == msgs

    def test_trim(self):
        w = FixedSizeWindow(max_messages=3)
        msgs = [
            ConversationMessage(role="user", content=f"u{i}", timestamp=float(i))
            for i in range(10)
        ]
        kept = w.apply(msgs)
        assert len(kept) == 3
        assert kept[0].content == "u7"
        assert kept[2].content == "u9"

    def test_raises_on_zero(self):
        with pytest.raises(ValueError, match="max_messages must be >= 1"):
            FixedSizeWindow(max_messages=0)

    def test_budget_description(self):
        w = FixedSizeWindow(max_messages=42)
        assert "max_messages=42" in w.budget_description


# ===========================================================================
# InMemoryStore
# ===========================================================================


class TestInMemoryStore:
    @pytest.fixture
    def store(self):
        return InMemoryStore(config=ContextConfig(ttl_seconds=3600, max_sessions=100))

    @pytest.mark.asyncio
    async def test_load_nonexistent(self, store):
        assert await store.load("no-such-session") is None

    @pytest.mark.asyncio
    async def test_save_and_load(self, store):
        ctx = ConversationContext(
            session_id="s1",
            messages=[
                ConversationMessage(role="user", content="hi", timestamp=1.0),
            ],
        )
        await store.save("s1", ctx)
        loaded = await store.load("s1")
        assert loaded is not None
        assert loaded.session_id == "s1"
        assert len(loaded.messages) == 1

    @pytest.mark.asyncio
    async def test_append_new_session(self, store):
        msg = ConversationMessage(role="user", content="hello", timestamp=1.0)
        await store.append("new-session", msg)
        ctx = await store.load("new-session")
        assert ctx is not None
        assert len(ctx.messages) == 1
        assert ctx.messages[0].content == "hello"

    @pytest.mark.asyncio
    async def test_append_existing(self, store):
        ctx = ConversationContext(
            session_id="s1",
            messages=[
                ConversationMessage(role="user", content="u1", timestamp=1.0),
            ],
        )
        await store.save("s1", ctx)
        await store.append(
            "s1", ConversationMessage(role="assistant", content="a1", timestamp=2.0)
        )
        loaded = await store.load("s1")
        assert len(loaded.messages) == 2

    @pytest.mark.asyncio
    async def test_append_batch_atomic(self, store):
        msgs = [
            ConversationMessage(role="user", content="u1", timestamp=1.0),
            ConversationMessage(role="assistant", content="a1", timestamp=2.0),
        ]
        await store.append_batch("batch-session", msgs)
        ctx = await store.load("batch-session")
        assert len(ctx.messages) == 2

    @pytest.mark.asyncio
    async def test_delete(self, store):
        ctx = ConversationContext(session_id="to-delete")
        await store.save("to-delete", ctx)
        assert await store.delete("to-delete") is True
        assert await store.load("to-delete") is None

    @pytest.mark.asyncio
    async def test_delete_nonexistent(self, store):
        assert await store.delete("no-such") is False

    @pytest.mark.asyncio
    async def test_exists(self, store):
        ctx = ConversationContext(session_id="exists-session")
        await store.save("exists-session", ctx)
        assert await store.exists("exists-session") is True

    @pytest.mark.asyncio
    async def test_not_exists(self, store):
        assert await store.exists("no-such") is False

    @pytest.mark.asyncio
    async def test_session_count(self, store):
        assert await store.session_count() == 0
        for i in range(5):
            ctx = ConversationContext(session_id=f"s{i}")
            await store.save(f"s{i}", ctx)
        assert await store.session_count() == 5

    @pytest.mark.asyncio
    async def test_cleanup_expired(self, store):
        store._config.ttl_seconds = 1  # 1 second TTL
        ctx = ConversationContext(session_id="expired-early")
        await store.save("expired-early", ctx)
        await store.save("fresh", ConversationContext(session_id="fresh"))
        # Wait for expiry
        time.sleep(1.1)
        removed = await store.cleanup_expired(ttl_seconds=1)
        assert removed >= 1
        assert await store.load("expired-early") is None

    @pytest.mark.asyncio
    async def test_lru_eviction(self, store):
        store._config.max_sessions = 3
        for i in range(3):
            await store.save(f"s{i}", ConversationContext(session_id=f"s{i}"))
        # Add a 4th session, LRU (s0) should be evicted
        await store.save("s3", ConversationContext(session_id="s3"))
        assert await store.load("s0") is None
        assert await store.load("s3") is not None

    @pytest.mark.asyncio
    async def test_ttl_renew_on_load(self, store):
        store._config.ttl_seconds = 3600
        ctx = ConversationContext(session_id="renew-test")
        await store.save("renew-test", ctx)
        old_updated = ctx.updated_at
        time.sleep(0.02)
        await store.load("renew-test")  # calls touch()
        assert ctx.updated_at > old_updated


# ===========================================================================
# Compression
# ===========================================================================


class TestTurnThreshold:
    def test_below_max_turns(self):
        trigger = TurnThreshold(max_turns=5, cooldown_turns=3)
        msgs = [
            ConversationMessage(role="user", content="u", timestamp=float(i))
            for i in range(4)
        ]  # 2 turns, below 5
        assert not trigger(
            messages=msgs, summary=None, turns_since_last=0, last_compressed_at=None
        )

    def test_above_max_turns(self):
        trigger = TurnThreshold(max_turns=2, cooldown_turns=3)
        msgs = [
            ConversationMessage(
                role="user" if i % 2 == 0 else "assistant",
                content=f"m{i}",
                timestamp=float(i),
            )
            for i in range(6)
        ]  # 3 turns, above 2
        assert trigger(
            messages=msgs, summary=None, turns_since_last=5, last_compressed_at=None
        )

    def test_respects_cooldown(self):
        trigger = TurnThreshold(max_turns=2, cooldown_turns=5)
        msgs = [
            ConversationMessage(
                role="user" if i % 2 == 0 else "assistant",
                content=f"m{i}",
                timestamp=float(i),
            )
            for i in range(6)
        ]
        # Already compressed once, only 1 turn since last → should NOT fire
        assert not trigger(
            messages=msgs, summary="prev", turns_since_last=1, last_compressed_at=100.0
        )

    def test_cooldown_bypass_on_first_compression(self):
        trigger = TurnThreshold(max_turns=2, cooldown_turns=5)
        msgs = [
            ConversationMessage(
                role="user" if i % 2 == 0 else "assistant",
                content=f"m{i}",
                timestamp=float(i),
            )
            for i in range(6)
        ]
        # First compression: last_compressed_at is None → ignore cooldown
        assert trigger(
            messages=msgs, summary=None, turns_since_last=0, last_compressed_at=None
        )


class TestSummarizeFn:
    @pytest.mark.asyncio
    async def test_happy_path(self):
        llm_mock = AsyncMock(
            return_value="讨论主题：测试\n【摘要正文】这是一个测试摘要。"
        )
        fn = build_summarize_fn(llm_mock, max_chars=500)
        old = [
            ConversationMessage(role="user", content="u1", timestamp=1.0),
            ConversationMessage(role="assistant", content="a1", timestamp=2.0),
        ]
        recent = [ConversationMessage(role="user", content="u2", timestamp=3.0)]
        result = await fn(old, recent, previous_summary=None)
        assert "讨论主题" in result
        assert "测试" in result

    @pytest.mark.asyncio
    async def test_fallback_on_exception(self):
        llm_mock = AsyncMock(side_effect=RuntimeError("LLM down"))
        fn = build_summarize_fn(llm_mock)
        old = [
            ConversationMessage(role="user", content="u1", timestamp=1.0),
            ConversationMessage(role="assistant", content="a1", timestamp=2.0),
        ]
        result = await fn(old, [], previous_summary=None)
        # Falls back to raw text of last 6 messages (old)
        assert "u1" in result

    @pytest.mark.asyncio
    async def test_strips_common_prefix(self):
        llm_mock = AsyncMock(return_value="好的，以下是摘要：\n【讨论主题】测试")
        fn = build_summarize_fn(llm_mock)
        old = [ConversationMessage(role="user", content="u1", timestamp=1.0)]
        result = await fn(old, [], previous_summary=None)
        assert "【讨论主题】" in result


class TestConversationCompressor:
    @pytest.fixture
    def compressor(self):
        return ConversationCompressor(
            max_recent_turns=2,
            trigger=TurnThreshold(max_turns=3, cooldown_turns=2),
        )

    def _make_msgs(self, n_pairs: int) -> list[ConversationMessage]:
        msgs = []
        for i in range(n_pairs):
            msgs.append(
                ConversationMessage(
                    role="user", content=f"u{i}", timestamp=float(i * 2)
                )
            )
            msgs.append(
                ConversationMessage(
                    role="assistant", content=f"a{i}", timestamp=float(i * 2 + 1)
                )
            )
        return msgs

    @pytest.mark.asyncio
    async def test_no_compression_below_threshold(self, compressor):
        summarize_fn = AsyncMock(return_value="summary")
        msgs = self._make_msgs(2)  # 2 turns, below max_turns=3
        result = await compressor.compress(msgs, summarize_fn)
        assert not result.did_compress
        assert len(result.kept_messages) == len(msgs)

    @pytest.mark.asyncio
    async def test_compression_above_threshold(self, compressor):
        summarize_fn = AsyncMock(return_value="【讨论主题】综合摘要")
        msgs = self._make_msgs(5)  # 5 turns, above max_turns=3
        result = await compressor.compress(msgs, summarize_fn)
        assert result.did_compress
        assert result.summary == "【讨论主题】综合摘要"
        assert len(result.kept_messages) == 4  # last 2 turns = 4 msgs
        assert result.compressed_count > 0

    @pytest.mark.asyncio
    async def test_force_compress(self, compressor):
        summarize_fn = AsyncMock(return_value="forced")
        msgs = self._make_msgs(5)  # 5 turns, exceeds max_recent_turns=2 → has old data
        result = await compressor.force_compress(msgs, summarize_fn)
        assert result.did_compress
        assert result.summary == "forced"

    def test_reset_clears_state(self, compressor):
        compressor._summary = "old"
        compressor._last_compressed_at = 100.0
        compressor._turns_since_last = 5
        compressor.reset()
        assert compressor._summary is None
        assert compressor._last_compressed_at is None
        assert compressor._turns_since_last == 0


# ===========================================================================
# ContextManager
# ===========================================================================


class TestContextManager:
    @pytest.fixture
    def manager(self):
        return ContextManager(
            config=ContextConfig(
                max_turns=10,
                ttl_seconds=3600,
                max_sessions=100,
                cleanup_interval=0,  # disable background cleanup
            )
        )

    @pytest.mark.asyncio
    async def test_get_context_empty(self, manager):
        msgs = await manager.get_context("no-session")
        assert msgs == []

    @pytest.mark.asyncio
    async def test_add_message(self, manager):
        await manager.add_user_message("s1", "hello")
        msgs = await manager.get_context("s1")
        assert len(msgs) == 1
        assert msgs[0].role == "user"
        assert msgs[0].content == "hello"

    @pytest.mark.asyncio
    async def test_add_assistant_message(self, manager):
        await manager.add_assistant_message("s1", "world")
        msgs = await manager.get_context("s1")
        assert msgs[0].role == "assistant"

    @pytest.mark.asyncio
    async def test_add_turn_atomic(self, manager):
        await manager.add_turn("s1", "user text", "assistant text")
        msgs = await manager.get_context("s1")
        assert len(msgs) == 2
        assert msgs[0].role == "user"
        assert msgs[0].content == "user text"
        assert msgs[1].role == "assistant"
        assert msgs[1].content == "assistant text"

    @pytest.mark.asyncio
    async def test_get_context_raw(self, manager):
        await manager.add_user_message("s1", "m1")
        await manager.add_assistant_message("s1", "m2")
        raw = await manager.get_context_raw("s1")
        assert len(raw) == 2

    @pytest.mark.asyncio
    async def test_turn_count(self, manager):
        assert await manager.turn_count("s1") == 0
        await manager.add_turn("s1", "u1", "a1")
        assert await manager.turn_count("s1") == 1

    @pytest.mark.asyncio
    async def test_message_count(self, manager):
        assert await manager.message_count("s1") == 0
        await manager.add_message(
            "s1", ConversationMessage(role="user", content="hi", timestamp=1.0)
        )
        assert await manager.message_count("s1") == 1

    @pytest.mark.asyncio
    async def test_session_count(self, manager):
        assert await manager.session_count() == 0
        await manager.add_user_message("s1", "hi")
        await manager.add_user_message("s2", "ho")
        assert await manager.session_count() == 2

    @pytest.mark.asyncio
    async def test_exists(self, manager):
        assert await manager.exists("s1") is False
        await manager.add_user_message("s1", "hi")
        assert await manager.exists("s1") is True

    @pytest.mark.asyncio
    async def test_clear(self, manager):
        await manager.add_user_message("s1", "hi")
        assert await manager.clear("s1") is True
        assert await manager.clear("s1") is False

    @pytest.mark.asyncio
    async def test_replace_all(self, manager):
        await manager.add_user_message("s1", "old")
        new_msgs = [ConversationMessage(role="user", content="new", timestamp=9.0)]
        await manager.replace_all("s1", new_msgs)
        msgs = await manager.get_context("s1")
        assert len(msgs) == 1
        assert msgs[0].content == "new"

    @pytest.mark.asyncio
    async def test_window_trimming(self, manager):
        """Manager should apply the window strategy on get_context."""
        manager._window = SlidingTurnWindow(max_turns=1)
        await manager.add_turn("s1", "u1", "a1")
        await manager.add_turn("s1", "u2", "a2")
        msgs = await manager.get_context("s1")
        assert len(msgs) == 2  # only last turn
        assert msgs[0].content == "u2"
        assert msgs[1].content == "a2"

    @pytest.mark.asyncio
    async def test_start_stop_cleanup(self, manager):
        manager._config.cleanup_interval = 1
        manager._config.ttl_seconds = 1
        await manager.start_cleanup()
        assert manager._cleanup_task is not None
        assert not manager._cleanup_task.done()
        await manager.stop_cleanup()
        assert manager._cleanup_task is None


# ===========================================================================
# Dependency injection
# ===========================================================================


class TestDependency:
    def teardown_method(self):
        reset_context_manager()

    def test_init_returns_manager(self):
        mgr = init_context_manager()
        assert isinstance(mgr, ContextManager)

    def test_init_singleton(self):
        mgr1 = init_context_manager()
        mgr2 = init_context_manager()
        assert mgr1 is mgr2

    def test_init_respects_config(self):
        cfg = ContextConfig(max_turns=5)
        mgr = init_context_manager(config=cfg)
        assert mgr._config.max_turns == 5

    def test_reset(self):
        mgr1 = init_context_manager()
        reset_context_manager()
        mgr2 = init_context_manager()
        assert mgr1 is not mgr2


# ===========================================================================
# LangGraph Tools (light path — no LLM, no MongoDB)
# ===========================================================================


class TestContextTools:
    @pytest.fixture
    def manager(self):
        return ContextManager(
            config=ContextConfig(max_turns=20, ttl_seconds=3600, cleanup_interval=0)
        )

    @pytest.fixture
    def tools(self, manager):
        return create_context_tools(context_manager=manager)

    @pytest.mark.asyncio
    async def test_get_recent_context_no_session(self, tools):
        result = await tools[3].ainvoke(
            {
                "chat_session_id": "no-session",
                "n_messages": 20,
            }
        )
        assert "尚无对话记录" in result

    @pytest.mark.asyncio
    async def test_get_recent_context_with_data(self, manager, tools):
        await manager.add_turn("s1", "你好", "你好！有什么帮助吗？")
        result = await tools[3].ainvoke(
            {
                "chat_session_id": "s1",
                "n_messages": 10,
            }
        )
        assert "你好" in result
        assert "最近对话记录" in result

    @pytest.mark.asyncio
    async def test_search_chat_history_no_mongo(self, tools):
        """When MongoDB is disabled, gracefully returns 'not found'."""
        result = await tools[0].ainvoke(
            {
                "chat_session_id": "s1",
                "query": "test query",
            }
        )
        assert "未在" in result and "找到" in result

    @pytest.mark.asyncio
    async def test_search_chat_history_with_summarize_fn_graceful(self, manager):
        """With llm_invoke provided but MongoDB disabled, returns fallback."""
        llm_mock = AsyncMock(return_value="【讨论主题】测试")
        tools = create_context_tools(context_manager=manager, llm_invoke=llm_mock)
        result = await tools[0].ainvoke(
            {
                "chat_session_id": "s1",
                "query": "测试主题",
            }
        )
        # MongoDB is disabled in the test environment, so returns "not found"
        assert "未在" in result and "找到" in result

    @pytest.mark.asyncio
    async def test_tool_names_and_schema(self, tools):
        names = [t.name for t in tools]
        assert "search_chat_history" in names
        assert "get_recent_context" in names

    @pytest.mark.asyncio
    async def test_get_recent_context_n_messages_param(self, manager, tools):
        await manager.add_turn("s1", "1", "a")
        await manager.add_turn("s1", "2", "b")
        await manager.add_turn("s1", "3", "c")
        # Request only 1 message
        result = await tools[3].ainvoke(
            {
                "chat_session_id": "s1",
                "n_messages": 1,
            }
        )
        # Should contain only the last assistant message's content
        assert "c" in result
