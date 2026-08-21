from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from app.models import ChatSession
from app.services import chat_history as chat_history_service


async def _create_session(test_db, *, chat_session_id: str, uid: int, title: str):
    now = datetime.now(timezone.utc)
    session = ChatSession(
        chat_session_id=chat_session_id,
        uid=uid,
        title=title,
        status="active",
        created_at=now,
        updated_at=now,
    )
    test_db.add(session)
    await test_db.commit()
    return session


@pytest.mark.asyncio
async def test_get_chat_session_for_user_hides_other_users_session(test_db):
    await _create_session(
        test_db,
        chat_session_id="owned-by-7",
        uid=7,
        title="owner session",
    )

    session = await chat_history_service.get_chat_session_for_user(
        test_db,
        uid=42,
        chat_session_id="owned-by-7",
    )

    assert session is None


@pytest.mark.asyncio
async def test_update_chat_session_title_for_user_does_not_update_other_user(test_db):
    await _create_session(
        test_db,
        chat_session_id="owned-by-7",
        uid=7,
        title="owner session",
    )

    updated = await chat_history_service.update_chat_session_title_for_user(
        test_db,
        uid=42,
        chat_session_id="owned-by-7",
        title="attacker rename",
    )

    result = await test_db.execute(
        select(ChatSession).where(ChatSession.chat_session_id == "owned-by-7")
    )
    current = result.scalar_one()
    assert updated is False
    assert current.title == "owner session"


@pytest.mark.asyncio
async def test_delete_chat_session_for_user_does_not_delete_other_user(
    test_db, monkeypatch
):
    await _create_session(
        test_db,
        chat_session_id="owned-by-7",
        uid=7,
        title="owner session",
    )
    delete_messages = AsyncMock()
    monkeypatch.setattr(
        chat_history_service.mongo_chat,
        "delete_session_messages_for_user",
        delete_messages,
    )

    deleted = await chat_history_service.delete_chat_session_for_user(
        test_db,
        uid=42,
        chat_session_id="owned-by-7",
    )

    result = await test_db.execute(
        select(ChatSession).where(ChatSession.chat_session_id == "owned-by-7")
    )
    assert deleted is False
    assert result.scalar_one_or_none() is not None
    delete_messages.assert_not_awaited()


@pytest.mark.asyncio
async def test_get_history_for_user_does_not_read_other_user_messages(
    test_db, monkeypatch
):
    await _create_session(
        test_db,
        chat_session_id="owned-by-7",
        uid=7,
        title="owner session",
    )
    get_messages_for_user = AsyncMock(return_value=([{"content": "secret"}], 1))
    monkeypatch.setattr(
        chat_history_service.mongo_chat, "get_messages_for_user", get_messages_for_user
    )

    result = await chat_history_service.get_history_for_user(
        test_db,
        uid=42,
        chat_session_id="owned-by-7",
        page=1,
        page_size=50,
    )

    assert result is None
    get_messages_for_user.assert_not_awaited()


@pytest.mark.asyncio
async def test_clear_history_for_user_does_not_clear_other_user_messages(
    test_db, monkeypatch
):
    await _create_session(
        test_db,
        chat_session_id="owned-by-7",
        uid=7,
        title="owner session",
    )
    delete_messages = AsyncMock(return_value=3)
    monkeypatch.setattr(
        chat_history_service.mongo_chat,
        "delete_session_messages_for_user",
        delete_messages,
    )

    cleared = await chat_history_service.clear_history_for_user(
        test_db,
        uid=42,
        chat_session_id="owned-by-7",
    )

    assert cleared is False
    delete_messages.assert_not_awaited()


@pytest.mark.asyncio
async def test_get_or_create_chat_session_does_not_reuse_other_user_session(test_db):
    await _create_session(
        test_db,
        chat_session_id="owned-by-7",
        uid=7,
        title="owner session",
    )

    session = await chat_history_service.get_or_create_chat_session(
        test_db,
        uid=42,
        chat_session_id="owned-by-7",
        title="new session",
    )

    assert session.uid == 42
    assert session.chat_session_id != "owned-by-7"


@pytest.mark.asyncio
async def test_get_or_create_chat_session_reuses_current_users_session(test_db):
    await _create_session(
        test_db,
        chat_session_id="owned-by-42",
        uid=42,
        title="current user session",
    )

    session = await chat_history_service.get_or_create_chat_session(
        test_db,
        uid=42,
        chat_session_id="owned-by-42",
        title="new session",
    )

    assert session.uid == 42
    assert session.chat_session_id == "owned-by-42"
