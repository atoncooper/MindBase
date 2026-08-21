from contextlib import asynccontextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select
from app.response.chat import ChatSessionResponse

from app.models import ChatSession


@pytest.mark.asyncio
async def test_generate_chat_title_updates_empty_session_title(test_db, monkeypatch):
    from app.services import chat_title

    now = datetime.now(timezone.utc)
    session = ChatSession(
        chat_session_id="chat-title-empty",
        uid=42,
        title=None,
        status="active",
        created_at=now,
        updated_at=now,
    )
    test_db.add(session)
    await test_db.commit()

    llm = SimpleNamespace(
        ainvoke=AsyncMock(
            return_value=SimpleNamespace(content="《RAG事务一致性分析》\n")
        )
    )

    await chat_title.generate_chat_title_from_first_message(
        test_db,
        chat_session_id="chat-title-empty",
        uid=42,
        first_message="帮我分析一下这个 RAG 项目的事务一致性问题",
        llm_factory=lambda uid: llm,
    )

    result = await test_db.execute(
        select(ChatSession).where(ChatSession.chat_session_id == "chat-title-empty")
    )
    updated = result.scalar_one()
    assert updated.title == "RAG事务一致性分析"


@pytest.mark.asyncio
async def test_generate_chat_title_does_not_overwrite_existing_title(test_db):
    from app.services import chat_title

    now = datetime.now(timezone.utc)
    session = ChatSession(
        chat_session_id="chat-title-existing",
        uid=42,
        title="用户手动标题",
        status="active",
        created_at=now,
        updated_at=now,
    )
    test_db.add(session)
    await test_db.commit()

    llm = SimpleNamespace(
        ainvoke=AsyncMock(return_value=SimpleNamespace(content="AI标题"))
    )

    await chat_title.generate_chat_title_from_first_message(
        test_db,
        chat_session_id="chat-title-existing",
        uid=42,
        first_message="帮我重新命名",
        llm_factory=lambda uid: llm,
    )

    result = await test_db.execute(
        select(ChatSession).where(ChatSession.chat_session_id == "chat-title-existing")
    )
    updated = result.scalar_one()
    assert updated.title == "用户手动标题"
    llm.ainvoke.assert_not_awaited()


@pytest.mark.asyncio
async def test_generate_chat_title_falls_back_when_llm_fails(test_db):
    from app.services import chat_title

    now = datetime.now(timezone.utc)
    session = ChatSession(
        chat_session_id="chat-title-fallback",
        uid=42,
        title="",
        status="active",
        created_at=now,
        updated_at=now,
    )
    test_db.add(session)
    await test_db.commit()

    llm = SimpleNamespace(
        ainvoke=AsyncMock(side_effect=RuntimeError("llm unavailable"))
    )
    first_message = (
        "我希望实现根据第一次对话实现聊天记录标题title的ai实现，类似chatgpt的功能"
    )

    await chat_title.generate_chat_title_from_first_message(
        test_db,
        chat_session_id="chat-title-fallback",
        uid=42,
        first_message=first_message,
        llm_factory=lambda uid: llm,
    )

    result = await test_db.execute(
        select(ChatSession).where(ChatSession.chat_session_id == "chat-title-fallback")
    )
    updated = result.scalar_one()
    assert updated.title == first_message[:18]


def test_sanitize_generated_title_removes_noise_and_limits_length():
    from app.services.chat_title import sanitize_generated_title

    title = sanitize_generated_title(
        '标题："如何修复登录框输入框不居中和文字贴边的问题"'
    )

    assert title == "如何修复登录框输入框不居中和文字贴边"
    assert len(title) <= 18


def test_schedule_chat_title_generation_uses_background_tasks(monkeypatch):
    from app.response.chat import ChatSessionResponse
    from app.services.chat import build_llm, schedule_title_generation

    scheduled = []

    class BackgroundTasks:
        def add_task(self, fn, *args, **kwargs):
            scheduled.append((fn, args, kwargs))

    session = ChatSessionResponse(
        id=1,
        chat_session_id="chat-schedule",
        uid=42,
        title=None,
        status="active",
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )

    schedule_title_generation(
        BackgroundTasks(),
        session,
        uid=42,
        first_message="如何实现 AI 标题生成？",
    )

    assert len(scheduled) == 1
    _, args, kwargs = scheduled[0]
    assert args == ()
    assert kwargs["chat_session_id"] == "chat-schedule"
    assert kwargs["uid"] == 42
    assert kwargs["first_message"] == "如何实现 AI 标题生成？"
    assert kwargs["llm_factory"] is build_llm


@pytest.mark.asyncio
async def test_generate_chat_title_atomic_update_does_not_overwrite_manual_title(
    test_db,
):
    from app.services import chat_title

    now = datetime.now(timezone.utc)
    session = ChatSession(
        chat_session_id="chat-title-manual-race",
        uid=42,
        title="手动标题",
        status="active",
        created_at=now,
        updated_at=now,
    )
    test_db.add(session)
    await test_db.commit()

    llm = SimpleNamespace(
        ainvoke=AsyncMock(return_value=SimpleNamespace(content="AI标题"))
    )

    updated = await chat_title.update_title_if_default(
        test_db,
        chat_session_id="chat-title-manual-race",
        uid=42,
        title="AI标题",
    )

    result = await test_db.execute(
        select(ChatSession).where(
            ChatSession.chat_session_id == "chat-title-manual-race"
        )
    )
    current = result.scalar_one()
    assert updated is False
    assert current.title == "手动标题"
    llm.ainvoke.assert_not_awaited()


@pytest.mark.asyncio
async def test_generate_chat_title_does_not_overwrite_title_changed_during_llm(test_db):
    from app.services import chat_title

    now = datetime.now(timezone.utc)
    session = ChatSession(
        chat_session_id="chat-title-race-path",
        uid=42,
        title=None,
        status="active",
        created_at=now,
        updated_at=now,
    )
    test_db.add(session)
    await test_db.commit()

    async def rename_before_return(messages):
        result = await test_db.execute(
            select(ChatSession).where(
                ChatSession.chat_session_id == "chat-title-race-path"
            )
        )
        current = result.scalar_one()
        current.title = "用户刚刚手动改名"
        await test_db.commit()
        return SimpleNamespace(content="AI生成标题")

    llm = SimpleNamespace(ainvoke=AsyncMock(side_effect=rename_before_return))

    await chat_title.generate_chat_title_from_first_message(
        test_db,
        chat_session_id="chat-title-race-path",
        uid=42,
        first_message="帮我生成标题",
        llm_factory=lambda uid: llm,
    )

    result = await test_db.execute(
        select(ChatSession).where(ChatSession.chat_session_id == "chat-title-race-path")
    )
    current = result.scalar_one()
    assert current.title == "用户刚刚手动改名"


@pytest.mark.asyncio
async def test_generate_chat_title_background_commits_with_own_scope(
    test_db, monkeypatch
):
    from app.services import chat_title

    now = datetime.now(timezone.utc)
    session = ChatSession(
        chat_session_id="chat-title-background",
        uid=42,
        title=None,
        status="active",
        created_at=now,
        updated_at=now,
    )
    test_db.add(session)
    await test_db.commit()

    @asynccontextmanager
    async def scope(*, readonly=False):
        yield test_db
        await test_db.commit()

    monkeypatch.setattr(chat_title, "transactional_scope", scope)
    llm = SimpleNamespace(
        ainvoke=AsyncMock(return_value=SimpleNamespace(content="后台标题"))
    )

    await chat_title.generate_chat_title_background(
        chat_session_id="chat-title-background",
        uid=42,
        first_message="后台生成标题",
        llm_factory=lambda uid: llm,
    )

    result = await test_db.execute(
        select(ChatSession).where(
            ChatSession.chat_session_id == "chat-title-background"
        )
    )
    current = result.scalar_one()
    assert current.title == "后台标题"


def test_schedule_chat_title_generation_skips_non_first_message():
    from app.services.chat import schedule_title_generation

    class BackgroundTasks:
        def add_task(self, fn, *args, **kwargs):
            raise AssertionError("should not schedule")

    session = ChatSessionResponse(
        id=1,
        chat_session_id="chat-schedule",
        uid=42,
        title=None,
        status="active",
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
        last_message_at=datetime.now(timezone.utc),
    )

    schedule_title_generation(
        BackgroundTasks(),
        session,
        uid=42,
        first_message="第二条消息不应生成标题",
    )


def test_schedule_chat_title_generation_skips_existing_title():
    from app.services.chat import schedule_title_generation

    class BackgroundTasks:
        def add_task(self, fn, *args, **kwargs):
            raise AssertionError("should not schedule")

    session = ChatSessionResponse(
        id=1,
        chat_session_id="chat-schedule",
        uid=42,
        title="已有标题",
        status="active",
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )

    schedule_title_generation(
        BackgroundTasks(),
        session,
        uid=42,
        first_message="如何实现 AI 标题生成？",
    )
