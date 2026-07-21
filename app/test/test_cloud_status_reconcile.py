# app/test/test_cloud_status_reconcile.py
# 读时对账：状态/详情/列表接口在 DB 标 done 但 Milvus 无向量时 flip failed
# 直接调用路由函数（绕过 HTTP/Depends），聚焦校验+flip 逻辑本身。

import pytest
import pytest_asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import StaticPool

from app.models import Base, CloudFile
from app.routers.cloud import get_video_detail, get_video_status, list_videos


# ==================== Fixtures ====================


@pytest_asyncio.fixture(scope="function")
async def test_db():
    """In-memory SQLite session per test."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        echo=False,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async_session = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with async_session() as session:
        yield session
    await engine.dispose()


async def _make_file(
    test_db, vector_status="done", vector_chunk_count=5, uuid="uuid-test"
):
    """Insert a CloudFile row scoped to uid=123."""
    f = CloudFile(
        upload_uuid=uuid,
        uid=123,
        original_name="x.pdf",
        file_size=100,
        mime_type="application/pdf",
        bucket="b",
        object_key="k",
        asr_status="done",
        vector_status=vector_status,
        vector_chunk_count=vector_chunk_count,
    )
    test_db.add(f)
    await test_db.commit()
    return f


async def _fetch_file(test_db, uuid="uuid-test"):
    return (
        await test_db.execute(
            select(CloudFile).where(CloudFile.upload_uuid == uuid)
        )
    ).scalar_one()


def _mock_rag(count, backend_present=True):
    rag = MagicMock()
    rag.cloud_backend = MagicMock() if backend_present else None
    rag.count_cloud_chunks.return_value = count
    return rag


# ==================== /video/{uuid}/status ====================


class TestGetVideoStatusReconcile:
    @pytest.mark.asyncio
    async def test_done_with_vectors_stays_done(self, test_db):
        await _make_file(test_db, "done", 5)
        rag = _mock_rag(count=5, backend_present=True)
        with patch("app.services.rag.get_rag_service", return_value=rag), patch(
            "app.routers.cloud.config"
        ) as cfg:
            cfg.milvus.enabled = True
            resp = await get_video_status("uuid-test", uid=123, db=test_db)

        assert resp.vectorStatus == "done"
        assert resp.vectorChunkCount == 5
        f = await _fetch_file(test_db)
        assert f.vector_status == "done"

    @pytest.mark.asyncio
    async def test_done_with_zero_flips_failed(self, test_db):
        await _make_file(test_db, "done", 5)
        rag = _mock_rag(count=0, backend_present=True)
        with patch("app.services.rag.get_rag_service", return_value=rag), patch(
            "app.routers.cloud.config"
        ) as cfg:
            cfg.milvus.enabled = True
            resp = await get_video_status("uuid-test", uid=123, db=test_db)

        assert resp.vectorStatus == "failed"
        f = await _fetch_file(test_db)
        assert f.vector_status == "failed"

    @pytest.mark.asyncio
    async def test_done_milvus_not_configured_no_flip(self, test_db):
        await _make_file(test_db, "done", 5)
        rag = _mock_rag(count=0, backend_present=False)
        with patch("app.services.rag.get_rag_service", return_value=rag), patch(
            "app.routers.cloud.config"
        ) as cfg:
            cfg.milvus.enabled = True
            resp = await get_video_status("uuid-test", uid=123, db=test_db)

        assert resp.vectorStatus == "done"
        rag.count_cloud_chunks.assert_not_called()
        f = await _fetch_file(test_db)
        assert f.vector_status == "done"

    @pytest.mark.asyncio
    async def test_milvus_disabled_no_check(self, test_db):
        await _make_file(test_db, "done", 5)
        rag = _mock_rag(count=0, backend_present=True)
        with patch("app.services.rag.get_rag_service", return_value=rag), patch(
            "app.routers.cloud.config"
        ) as cfg:
            cfg.milvus.enabled = False
            resp = await get_video_status("uuid-test", uid=123, db=test_db)

        assert resp.vectorStatus == "done"
        rag.count_cloud_chunks.assert_not_called()

    @pytest.mark.asyncio
    async def test_processing_not_checked(self, test_db):
        await _make_file(test_db, "processing", 0)
        rag = _mock_rag(count=0, backend_present=True)
        with patch("app.services.rag.get_rag_service", return_value=rag), patch(
            "app.routers.cloud.config"
        ) as cfg:
            cfg.milvus.enabled = True
            resp = await get_video_status("uuid-test", uid=123, db=test_db)

        assert resp.vectorStatus == "processing"
        rag.count_cloud_chunks.assert_not_called()
        f = await _fetch_file(test_db)
        assert f.vector_status == "processing"


# ==================== /video/{uuid} (detail) ====================


class TestGetVideoDetailReconcile:
    @pytest.mark.asyncio
    async def test_detail_done_with_zero_flips_failed(self, test_db):
        await _make_file(test_db, "done", 5)
        rag = _mock_rag(count=0, backend_present=True)
        with patch("app.services.rag.get_rag_service", return_value=rag), patch(
            "app.routers.cloud.config"
        ) as cfg:
            cfg.milvus.enabled = True
            resp = await get_video_detail("uuid-test", uid=123, db=test_db)

        assert resp.vectorStatus == "failed"
        f = await _fetch_file(test_db)
        assert f.vector_status == "failed"

    @pytest.mark.asyncio
    async def test_detail_done_with_vectors_stays_done(self, test_db):
        await _make_file(test_db, "done", 5)
        rag = _mock_rag(count=5, backend_present=True)
        with patch("app.services.rag.get_rag_service", return_value=rag), patch(
            "app.routers.cloud.config"
        ) as cfg:
            cfg.milvus.enabled = True
            resp = await get_video_detail("uuid-test", uid=123, db=test_db)

        assert resp.vectorStatus == "done"
        f = await _fetch_file(test_db)
        assert f.vector_status == "done"


# ==================== /videos (list, batch) ====================


class TestListVideosReconcile:
    @pytest.mark.asyncio
    async def test_list_batch_flips_done_with_zero_vectors(self, test_db):
        """done(有向量) + done(无向量) + processing -> 仅无向量的 flip。"""
        f1 = await _make_file(test_db, "done", 5, uuid="u1")
        f2 = await _make_file(test_db, "done", 5, uuid="u2")
        f3 = await _make_file(test_db, "processing", 0, uuid="u3")

        rag = MagicMock()
        rag.cloud_backend = MagicMock()
        # u1 -> 5 (有), u2 -> 0 (无); u3 processing 不查
        rag.count_cloud_chunks.side_effect = [5, 0]

        file_repo = MagicMock()
        file_repo.list_by_folder = AsyncMock(return_value=([f1, f2, f3], 3))

        with patch(
            "app.routers.cloud._get_file_repo", return_value=file_repo
        ), patch(
            "app.services.rag.get_rag_service", return_value=rag
        ), patch("app.routers.cloud.config") as cfg:
            cfg.milvus.enabled = True
            resp = await list_videos(
                folderId=None,
                page=1,
                pageSize=50,
                sort="created_at",
                order="desc",
                uid=123,
                db=test_db,
            )

        statuses = {v.uploadUuid: v.vectorStatus for v in resp.videos}
        assert statuses["u1"] == "done"
        assert statuses["u2"] == "failed"
        assert statuses["u3"] == "processing"
        # DB 持久化
        assert (await _fetch_file(test_db, "u1")).vector_status == "done"
        assert (await _fetch_file(test_db, "u2")).vector_status == "failed"
        assert (await _fetch_file(test_db, "u3")).vector_status == "processing"

    @pytest.mark.asyncio
    async def test_list_milvus_not_configured_no_flip(self, test_db):
        f1 = await _make_file(test_db, "done", 5, uuid="u1")
        rag = _mock_rag(count=0, backend_present=False)
        file_repo = MagicMock()
        file_repo.list_by_folder = AsyncMock(return_value=([f1], 1))
        with patch(
            "app.routers.cloud._get_file_repo", return_value=file_repo
        ), patch(
            "app.services.rag.get_rag_service", return_value=rag
        ), patch("app.routers.cloud.config") as cfg:
            cfg.milvus.enabled = True
            resp = await list_videos(
                folderId=None,
                page=1,
                pageSize=50,
                sort="created_at",
                order="desc",
                uid=123,
                db=test_db,
            )

        assert resp.videos[0].vectorStatus == "done"
        rag.count_cloud_chunks.assert_not_called()
