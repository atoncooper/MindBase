"""Tests for WorkspaceRepository — CRUD, binding expansion, and caching."""

import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CloudFile, CloudFolder, User
from app.repository.workspace_repository import WorkspaceRepository


@pytest_asyncio.fixture
async def repo():
    return WorkspaceRepository(redis=None)


@pytest_asyncio.fixture
async def uid(test_db: AsyncSession):
    user = User(status="active")
    test_db.add(user)
    await test_db.commit()
    await test_db.refresh(user)
    return user.uid


# ====================================================================
# CRUD
# ====================================================================

class TestWorkspaceCRUD:
    async def test_create_workspace(self, test_db: AsyncSession, repo, uid):
        ws = await repo.create(uid, "我的工作区", test_db)
        assert ws.id is not None
        assert ws.name == "我的工作区"
        assert ws.uid == uid
        assert ws.file_count == 0

    async def test_create_with_options(self, test_db: AsyncSession, repo, uid):
        ws = await repo.create(
            uid, "研发笔记", test_db,
            description="Spring Cloud 相关",
            icon="layers",
            color="#22d3ee",
        )
        assert ws.description == "Spring Cloud 相关"
        assert ws.icon == "layers"
        assert ws.color == "#22d3ee"

    async def test_list_by_uid(self, test_db: AsyncSession, repo, uid):
        await repo.create(uid, "A", test_db)
        await repo.create(uid, "B", test_db)
        await repo.create(uid, "C", test_db)
        workspaces = await repo.list_by_uid(uid, test_db)
        assert len(workspaces) == 3

    async def test_list_other_user_workspaces_not_visible(self, test_db: AsyncSession, repo, uid):
        await repo.create(uid, "Mine", test_db)
        workspaces = await repo.list_by_uid(uid + 999, test_db)
        assert len(workspaces) == 0

    async def test_get_by_id_returns_workspace(self, test_db: AsyncSession, repo, uid):
        ws = await repo.create(uid, "Target", test_db)
        found = await repo.get_by_id(ws.id, uid, test_db)
        assert found is not None
        assert found.name == "Target"

    async def test_get_by_id_wrong_user_returns_none(self, test_db: AsyncSession, repo, uid):
        ws = await repo.create(uid, "Target", test_db)
        found = await repo.get_by_id(ws.id, uid + 999, test_db)
        assert found is None

    async def test_get_by_id_not_found(self, test_db: AsyncSession, repo, uid):
        found = await repo.get_by_id(99999, uid, test_db)
        assert found is None

    async def test_update_workspace(self, test_db: AsyncSession, repo, uid):
        ws = await repo.create(uid, "Old", test_db)
        updated = await repo.update(ws.id, uid, test_db, name="New")
        assert updated is not None
        assert updated.name == "New"

    async def test_update_wrong_user_returns_none(self, test_db: AsyncSession, repo, uid):
        ws = await repo.create(uid, "Mine", test_db)
        updated = await repo.update(ws.id, uid + 999, test_db, name="Stolen")
        assert updated is None

    async def test_soft_delete(self, test_db: AsyncSession, repo, uid):
        ws = await repo.create(uid, "ToDelete", test_db)
        ok = await repo.soft_delete(ws.id, uid, test_db)
        assert ok
        deleted_ws = await repo.get_by_id(ws.id, uid, test_db)
        assert deleted_ws is None

    async def test_soft_delete_not_in_list(self, test_db: AsyncSession, repo, uid):
        ws = await repo.create(uid, "ToDelete", test_db)
        await repo.soft_delete(ws.id, uid, test_db)
        workspaces = await repo.list_by_uid(uid, test_db)
        assert len(workspaces) == 0


# ====================================================================
# Bindings
# ====================================================================

class TestWorkspaceBindings:
    async def test_add_file_binding(self, test_db: AsyncSession, repo, uid):
        ws = await repo.create(uid, "WS", test_db)
        binding = await repo.add_binding(
            ws.id, uid, test_db,
            bind_type="file",
            upload_uuid="test-uuid-123",
            include_subfolders=False,
        )
        assert binding.id is not None
        assert binding.bind_type == "file"

    async def test_add_folder_binding(self, test_db: AsyncSession, repo, uid):
        folder = CloudFolder(uid=uid, name="MyFolder")
        test_db.add(folder)
        await test_db.commit()
        await test_db.refresh(folder)

        ws = await repo.create(uid, "WS", test_db)
        binding = await repo.add_binding(
            ws.id, uid, test_db,
            bind_type="folder",
            folder_id=folder.id,
            include_subfolders=True,
        )
        assert binding.bind_type == "folder"
        assert binding.include_subfolders

    async def test_get_bindings(self, test_db: AsyncSession, repo, uid):
        ws = await repo.create(uid, "WS", test_db)
        await repo.add_binding(ws.id, uid, test_db, bind_type="file", upload_uuid="a")
        await repo.add_binding(ws.id, uid, test_db, bind_type="file", upload_uuid="b")
        bindings = await repo.get_bindings(ws.id, uid, test_db)
        assert len(bindings) == 2

    async def test_remove_binding(self, test_db: AsyncSession, repo, uid):
        ws = await repo.create(uid, "WS", test_db)
        b = await repo.add_binding(ws.id, uid, test_db, bind_type="file", upload_uuid="x")
        ok = await repo.remove_binding(b.id, ws.id, uid, test_db)
        assert ok
        bindings = await repo.get_bindings(ws.id, uid, test_db)
        assert len(bindings) == 0

    async def test_remove_binding_wrong_workspace(self, test_db: AsyncSession, repo, uid):
        ws1 = await repo.create(uid, "WS1", test_db)
        ws2 = await repo.create(uid, "WS2", test_db)
        b = await repo.add_binding(ws1.id, uid, test_db, bind_type="file", upload_uuid="x")
        ok = await repo.remove_binding(b.id, ws2.id, uid, test_db)
        assert not ok

    async def test_expand_bindings_empty_workspace(self, test_db: AsyncSession, repo, uid):
        ws = await repo.create(uid, "Empty", test_db)
        uuids = await repo._expand_bindings_from_db(ws.id, uid, test_db)
        assert uuids == set()

    async def test_expand_bindings_file_only(self, test_db: AsyncSession, repo, uid):
        ws = await repo.create(uid, "WS", test_db)
        file = CloudFile(
            upload_uuid="f1", uid=uid, original_name="doc.md", file_size=100,
            mime_type="text/markdown", bucket="b", object_key="k",
            vectorizable=True,
        )
        test_db.add(file)
        await test_db.commit()

        await repo.add_binding(ws.id, uid, test_db, bind_type="file", upload_uuid="f1")
        uuids = await repo._expand_bindings_from_db(ws.id, uid, test_db)
        assert uuids == {"f1"}

    async def test_expand_bindings_filters_non_vectorizable(self, test_db: AsyncSession, repo, uid):
        ws = await repo.create(uid, "WS", test_db)
        f = CloudFile(
            upload_uuid="f1", uid=uid, original_name="img.png", file_size=100,
            mime_type="image/png", bucket="b", object_key="k",
            vectorizable=False,
        )
        test_db.add(f)
        await test_db.commit()

        await repo.add_binding(ws.id, uid, test_db, bind_type="file", upload_uuid="f1")
        uuids = await repo._expand_bindings_from_db(ws.id, uid, test_db)
        assert uuids == set()  # filtered out

    async def test_expand_bindings_deduplicates(self, test_db: AsyncSession, repo, uid):
        ws = await repo.create(uid, "WS", test_db)
        f = CloudFile(
            upload_uuid="f1", uid=uid, original_name="x", file_size=100,
            mime_type="text/plain", bucket="b", object_key="k",
            vectorizable=True,
        )
        test_db.add(f)
        await test_db.commit()

        await repo.add_binding(ws.id, uid, test_db, bind_type="file", upload_uuid="f1")
        await repo.add_binding(ws.id, uid, test_db, bind_type="file", upload_uuid="f1")
        uuids = await repo._expand_bindings_from_db(ws.id, uid, test_db)
        assert uuids == {"f1"}


# ====================================================================
# Stats
# ====================================================================

class TestWorkspaceStats:
    async def test_recalc_stats_updates_counts(self, test_db: AsyncSession, repo, uid):
        ws = await repo.create(uid, "WS", test_db)
        f = CloudFile(
            upload_uuid="f1", uid=uid, original_name="x", file_size=100,
            mime_type="text/plain", bucket="b", object_key="k",
            vectorizable=True, vector_chunk_count=5, vector_status="done",
        )
        test_db.add(f)
        await test_db.commit()

        await repo.add_binding(ws.id, uid, test_db, bind_type="file", upload_uuid="f1")
        ws2 = await repo.get_by_id(ws.id, uid, test_db)
        assert ws2 is not None
        assert ws2.file_count == 1
        assert ws2.chunk_count == 5
