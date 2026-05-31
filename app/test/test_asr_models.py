# app/test/test_asr_models.py
# ASR 分P模型测试

import pytest
import pytest_asyncio
from datetime import datetime


# ==================== Video 模型测试 ====================

class TestVideoModel:
    """Video ORM 模型测试"""

    @pytest.mark.asyncio
    async def test_video_page_creation(self, test_db):
        """测试 Video 写入"""
        from app.models import Video

        page = Video(
            bvid="BV1test34",
            cid=123456,
            page_index=0,
            page_title="P1. 引言",
            content="这是测试内容",
            content_source="asr",
            is_processed=True,
            version=1,
        )
        test_db.add(page)
        await test_db.commit()

        result = await test_db.execute(
            __import__('sqlalchemy').select(Video).where(
                Video.bvid == "BV1test34",
                Video.cid == 123456
            )
        )
        found = result.scalar_one()
        assert found.page_title == "P1. 引言"
        assert found.is_processed is True
        assert found.content_source == "asr"
        assert found.version == 1

    @pytest.mark.asyncio
    async def test_video_page_unique_constraint_bvid_cid(self, test_db):
        """同一 bvid+cid 不能重复"""
        from app.models import Video
        from sqlalchemy.exc import IntegrityError

        page1 = Video(
            bvid="BV1unique123",
            cid=999,
            page_index=0,
            page_title="P1",
        )
        test_db.add(page1)
        await test_db.commit()

        page2 = Video(
            bvid="BV1unique123",
            cid=999,  # same cid
            page_index=1,
            page_title="P2",
        )
        test_db.add(page2)
        with pytest.raises(IntegrityError):
            await test_db.commit()
        await test_db.rollback()

    @pytest.mark.asyncio
    async def test_video_page_version_defaults(self, test_db):
        """测试默认值"""
        from app.models import Video

        page = Video(
            bvid="BV1defaultTest",
            cid=111,
            page_index=0,
        )
        test_db.add(page)
        await test_db.commit()

        assert page.is_processed is False
        assert page.version == 1
        assert page.content is None
        assert page.content_source is None


# ==================== VideoVersion 模型测试 ====================

class TestVideoVersionModel:
    """VideoVersion ORM 模型测试"""

    @pytest.mark.asyncio
    async def test_version_creation(self, test_db):
        """测试 VideoVersion 写入"""
        from app.models import VideoVersion

        version = VideoVersion(
            bvid="BV1xx",
            cid=123,
            page_index=0,
            version=1,
            content="v1内容",
            content_source="asr",
            is_latest=True,
        )
        test_db.add(version)
        await test_db.commit()

        result = await test_db.execute(
            __import__('sqlalchemy').select(VideoVersion).where(
                VideoVersion.bvid == "BV1xx",
                VideoVersion.cid == 123
            )
        )
        found = result.scalar_one()
        assert found.version == 1
        assert found.content == "v1内容"
        assert found.content_source == "asr"
        assert found.is_latest is True

    @pytest.mark.asyncio
    async def test_version_chain(self, test_db):
        """测试版本链: v1 -> v2 -> v3"""
        from app.models import VideoVersion

        # v1
        v1 = VideoVersion(
            bvid="BV1chainTest",
            cid=555,
            page_index=0,
            version=1,
            content="v1内容",
            content_source="asr",
            is_latest=False,
        )
        test_db.add(v1)
        await test_db.flush()

        # v2
        v2 = VideoVersion(
            bvid="BV1chainTest",
            cid=555,
            page_index=0,
            version=2,
            content="v2内容",
            content_source="asr",
            is_latest=False,
        )
        test_db.add(v2)
        await test_db.flush()

        # v3 (latest)
        v3 = VideoVersion(
            bvid="BV1chainTest",
            cid=555,
            page_index=0,
            version=3,
            content="v3内容",
            content_source="user_edit",
            is_latest=True,
        )
        test_db.add(v3)
        await test_db.commit()

        result = await test_db.execute(
            __import__('sqlalchemy').select(VideoVersion)
            .where(
                VideoVersion.bvid == "BV1chainTest",
                VideoVersion.cid == 555
            )
            .order_by(VideoVersion.version.desc())
        )
        versions = result.scalars().all()
        assert len(versions) == 3
        assert versions[0].version == 3
        assert versions[0].is_latest is True
        assert versions[0].content_source == "user_edit"
        assert versions[1].is_latest is False
        assert versions[2].is_latest is False

    @pytest.mark.asyncio
    async def test_version_unique_constraint(self, test_db):
        """同一 bvid+cid+version 不能重复"""
        from app.models import VideoVersion
        from sqlalchemy.exc import IntegrityError

        v1 = VideoVersion(
            bvid="BV1dupVer",
            cid=777,
            page_index=0,
            version=1,
            content="内容1",
            content_source="asr",
        )
        test_db.add(v1)
        await test_db.commit()

        v2 = VideoVersion(
            bvid="BV1dupVer",
            cid=777,
            page_index=0,
            version=1,  # same version
            content="内容2",
            content_source="asr",
        )
        test_db.add(v2)
        with pytest.raises(IntegrityError):
            await test_db.commit()
        await test_db.rollback()


# ==================== Pydantic Schema 测试 ====================

class TestASRPydanticSchemas:
    """ASR Pydantic 模型测试"""

    def test_asr_content_response__exists(self):
        """ASRContentResponse exists=true"""
        from app.response.asr import ASRContentResponse

        resp = ASRContentResponse(
            exists=True,
            bvid="BV1test123",
            cid=123,
            page_index=0,
            page_title="P1. 测试",
            content="ASR转写内容",
            content_source="asr",
            version=1,
            is_processed=True,
        )
        assert resp.exists is True
        assert resp.bvid == "BV1test123"
        assert resp.content == "ASR转写内容"
        assert resp.content_source == "asr"
        assert resp.version == 1

    def test_asr_content_response__not_exists(self):
        """ASRContentResponse exists=false"""
        from app.response.asr import ASRContentResponse

        resp = ASRContentResponse(exists=False)
        assert resp.exists is False
        assert resp.bvid is None
        assert resp.content is None

    def test_asr_create_request(self):
        """ASRCreateRequest"""
        from app.response.asr import ASRCreateRequest

        req = ASRCreateRequest(
            bvid="BV1create123",
            cid=456,
            page_index=0,
            page_title="P1. 新建",
        )
        assert req.bvid == "BV1create123"
        assert req.cid == 456
        assert req.page_index == 0
        assert req.page_title == "P1. 新建"

    def test_asr_update_request(self):
        """ASRUpdateRequest"""
        from app.response.asr import ASRUpdateRequest

        req = ASRUpdateRequest(
            bvid="BV1update123",
            cid=789,
            content="用户编辑的内容",
        )
        assert req.bvid == "BV1update123"
        assert req.content == "用户编辑的内容"

    def test_asr_reasr_request(self):
        """ASRReASRRequest"""
        from app.response.asr import ASRReASRRequest

        req = ASRReASRRequest(bvid="BV1reasr123", cid=321)
        assert req.bvid == "BV1reasr123"
        assert req.cid == 321

    def test_asr_task_status(self):
        """ASRTaskStatus"""
        from app.response.asr import ASRTaskStatus

        status = ASRTaskStatus(
            task_id="task-123",
            status="processing",
            progress=50,
            message="转写中...",
        )
        assert status.task_id == "task-123"
        assert status.status == "processing"
        assert status.progress == 50

    def test_video_page_version_info(self):
        """VideoVersionInfo"""
        from app.response.asr import VideoVersionInfo
        from datetime import datetime

        now = datetime.utcnow()
        info = VideoVersionInfo(
            version=2,
            content_source="asr",
            content_preview="这是内容预览...",
            is_latest=True,
            created_at=now,
        )
        assert info.version == 2
        assert info.content_source == "asr"
        assert info.is_latest is True
        assert info.created_at == now
