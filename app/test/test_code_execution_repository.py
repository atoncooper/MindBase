"""Tests for code_execution_repository - Mongo persistence layer.

Mocks the Motor collection so no real Mongo connection is needed. Verifies
document shape on insert, ownership scoping on get/list, and that list
queries exclude the heavy code/stdout/artifacts fields.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.repository import code_execution_repository as repo

pytestmark = pytest.mark.asyncio


@pytest.fixture
def mock_collection():
    """Patch is_enabled True + coll() returns a mock collection."""
    with patch.object(repo, "is_enabled", return_value=True):
        collection = MagicMock()
        collection.insert_one = AsyncMock()
        collection.find_one = AsyncMock(return_value=None)
        collection.delete_one = AsyncMock(return_value=MagicMock(deleted_count=0))
        collection.count_documents = AsyncMock(return_value=0)
        # find() returns a cursor chain: sort().skip().limit().to_list()
        cursor = MagicMock()
        cursor.sort.return_value = cursor
        cursor.skip.return_value = cursor
        cursor.limit.return_value = cursor
        cursor.to_list = AsyncMock(return_value=[])
        collection.find.return_value = cursor
        with patch.object(repo, "coll", return_value=collection):
            yield collection


class TestInsert:
    async def test_insert_returns_exec_id_and_persists_document(self, mock_collection):
        exec_id = await repo.insert(
            uid=1,
            chat_session_id="s1",
            assistant_msg_id="m1",
            delegate_query="画爱心",
            code="print(1)",
            language="python",
            stdout="exitCode=0\n1",
            exit_code=0,
            latency_ms=100,
            artifacts=[{"name": "heart.png", "url": "u"}],
        )
        assert isinstance(exec_id, str) and len(exec_id) > 0
        mock_collection.insert_one.assert_awaited_once()
        doc = mock_collection.insert_one.call_args.args[0]
        assert doc["exec_id"] == exec_id
        assert doc["uid"] == 1
        assert doc["chat_session_id"] == "s1"
        assert doc["assistant_msg_id"] == "m1"
        assert doc["exit_code"] == 0
        assert doc["artifact_count"] == 1
        assert "created_at" in doc

    async def test_insert_when_disabled_returns_id_without_persisting(self):
        with patch.object(repo, "is_enabled", return_value=False):
            exec_id = await repo.insert(
                uid=1,
                chat_session_id="s",
                assistant_msg_id="m",
                delegate_query="q",
                code="c",
                language="python",
                stdout="o",
                exit_code=0,
                latency_ms=0,
            )
        assert isinstance(exec_id, str)


class TestGet:
    async def test_get_for_user_filters_by_uid(self, mock_collection):
        mock_collection.find_one = AsyncMock(
            return_value={"exec_id": "e1", "uid": 1}
        )
        await repo.get("e1", uid=1)
        mock_collection.find_one.assert_awaited_once_with(
            {"exec_id": "e1", "uid": 1}
        )

    async def test_get_for_admin_skips_uid_filter(self, mock_collection):
        await repo.get("e1", uid=None)
        mock_collection.find_one.assert_awaited_once_with({"exec_id": "e1"})


class TestList:
    async def test_list_by_msg_scopes_to_uid_and_excludes_heavy_fields(
        self, mock_collection
    ):
        await repo.list_by_msg("m1", uid=1, page=2, page_size=10)
        mock_collection.count_documents.assert_awaited_once_with(
            {"assistant_msg_id": "m1", "uid": 1}
        )
        mock_collection.find.assert_called_once()
        find_args = mock_collection.find.call_args
        assert find_args.args[0] == {"assistant_msg_id": "m1", "uid": 1}
        assert find_args.args[1] == repo._LIST_EXCLUSION

    async def test_list_for_admin_builds_time_range_query(self, mock_collection):
        from datetime import datetime, timezone

        since = datetime(2026, 1, 1, tzinfo=timezone.utc)
        until = datetime(2026, 2, 1, tzinfo=timezone.utc)
        await repo.list_for_admin(uid=5, since=since, until=until, page=1, page_size=20)
        mock_collection.count_documents.assert_awaited_once_with(
            {
                "uid": 5,
                "created_at": {"$gte": since, "$lte": until},
            }
        )


class TestDelete:
    async def test_delete_calls_delete_one_by_exec_id(self, mock_collection):
        mock_collection.delete_one = AsyncMock(
            return_value=MagicMock(deleted_count=1)
        )
        count = await repo.delete("e1")
        mock_collection.delete_one.assert_awaited_once_with({"exec_id": "e1"})
        assert count == 1

    async def test_delete_for_owner_filters_uid(self, mock_collection):
        await repo.delete_for_owner("e1", uid=5)
        mock_collection.delete_one.assert_awaited_once_with(
            {"exec_id": "e1", "uid": 5}
        )
