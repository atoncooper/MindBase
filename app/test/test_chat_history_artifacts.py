"""Tests for chat-history artifact persistence + presigned URL refresh.

Covers the Plan-A fix: artifacts (e.g. run_code images) are persisted on
the assistant message and every history read mints a fresh presigned URL
from the stored minio_key so the images survive session reloads.
"""

from contextlib import ExitStack
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import chat_history as chat_history_service

pytestmark = pytest.mark.asyncio

ART = {
    "name": "chart.png",
    "minio_key": "code-artifacts/1/abc-123/chart.png",
    "url": "http://old/presigned",  # originally-generated URL (may be expired)
    "content_type": "image/png",
    "size": 1234,
}


def _row(artifacts=None) -> dict:
    return {
        "msg_id": "m1",
        "chat_session_id": "s1",
        "role": "assistant",
        "content": "答案",
        "status": "completed",
        "sources": None,
        "artifacts": artifacts if artifacts is not None else [dict(ART)],
        "tokens_used": None,
        "model": None,
        "latency_ms": None,
        "error": None,
        "created_at": datetime.now(timezone.utc),
    }


def _history_ctx(rows, presigned=None, minio_enabled=True):
    """Enter all patches via ExitStack; returns (messages, total, mocks)."""
    stack = ExitStack()
    stack.enter_context(
        patch.object(
            chat_history_service,
            "get_chat_session_for_user",
            new=AsyncMock(return_value=object()),  # non-None session
        )
    )
    mock_get = stack.enter_context(
        patch(
            "app.repository.mongo_chat_repository.get_messages_for_user",
            new_callable=AsyncMock,
        )
    )
    stack.enter_context(patch("app.infra.minio.is_enabled", return_value=minio_enabled))
    mock_client = stack.enter_context(patch("app.infra.minio.get_minio_client"))
    client = MagicMock()
    if presigned is not None:
        client.presigned_get = AsyncMock(return_value=presigned)
    else:
        client.presigned_get = AsyncMock()
    mock_client.return_value = client
    mock_get.return_value = (rows, len(rows))
    return stack, client


class TestPersistArtifacts:
    async def test_complete_assistant_message_persists_artifacts(self) -> None:
        db = MagicMock()
        with patch(
            "app.repository.mongo_chat_repository.update_message_content",
            new_callable=AsyncMock,
        ) as mock_update:
            await chat_history_service.complete_assistant_message(
                db, msg_id="m1", content="答案", artifacts=[dict(ART)], sources=None,
            )
        kwargs = mock_update.call_args.kwargs
        assert kwargs["artifacts"] == [ART]

    async def test_no_artifacts_keeps_old_behavior(self) -> None:
        db = MagicMock()
        with patch(
            "app.repository.mongo_chat_repository.update_message_content",
            new_callable=AsyncMock,
        ) as mock_update:
            await chat_history_service.complete_assistant_message(
                db, msg_id="m1", content="x", sources=None,
            )
        kwargs = mock_update.call_args.kwargs
        assert kwargs.get("artifacts") is None


class TestHistoryReads:
    async def test_history_returns_artifacts_with_fresh_url(self) -> None:
        stack, client = _history_ctx([_row()], presigned="http://fresh/presigned")
        with stack:
            messages, total = await chat_history_service.get_history_for_user(
                MagicMock(), uid=1, chat_session_id="s1",
            )

        assert total == 1
        msg = messages[0]
        assert msg.artifacts is not None
        assert msg.artifacts[0]["minio_key"] == ART["minio_key"]
        assert msg.artifacts[0]["url"] == "http://fresh/presigned"
        client.presigned_get.assert_awaited_once_with(ART["minio_key"])

    async def test_history_keeps_stored_url_when_minio_disabled(self) -> None:
        stack, client = _history_ctx([_row()], presigned=None, minio_enabled=False)
        with stack:
            messages, total = await chat_history_service.get_history_for_user(
                MagicMock(), uid=1, chat_session_id="s1",
            )

        # minio disabled -> stored url kept, no presign call
        assert messages[0].artifacts[0]["url"] == ART["url"]
        client.presigned_get.assert_not_awaited()

    async def test_history_without_artifacts_unchanged(self) -> None:
        row = _row(None)
        row["artifacts"] = None
        stack, _ = _history_ctx([row], presigned="x")
        with stack:
            messages, total = await chat_history_service.get_history_for_user(
                MagicMock(), uid=1, chat_session_id="s1",
            )

        assert messages[0].artifacts is None

    async def test_presign_failure_keeps_stored_url(self) -> None:
        stack, client = _history_ctx([_row()], presigned="http://fresh/presigned")
        client.presigned_get = AsyncMock(side_effect=RuntimeError("minio down"))
        with stack:
            messages, _ = await chat_history_service.get_history_for_user(
                MagicMock(), uid=1, chat_session_id="s1",
            )

        # graceful degradation: old url survives
        assert messages[0].artifacts[0]["url"] == ART["url"]
