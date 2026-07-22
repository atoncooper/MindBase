"""test_usage_repository.py — 测试 UsageRepository 的 batch_record 和 record 方法"""
import pytest
import pytest_asyncio
from sqlalchemy import select, func
from app.repository.usage_repository import UsageRepository, get_usage_repository
from app.models import CredentialUsage


class TestBatchRecord:
    """batch_record() 批量写入测试"""

    @pytest_asyncio.fixture(scope="function")
    async def repo(self):
        return UsageRepository()

    @pytest.mark.asyncio
    async def test_empty_list_noop(self, test_db, repo):
        """空列表不执行任何操作，不抛异常"""
        await repo.batch_record([], test_db)
        # 验证未写入任何记录
        result = await test_db.execute(select(func.count(CredentialUsage.id)))
        count = result.scalar()
        assert count == 0

    @pytest.mark.asyncio
    async def test_single_record(self, test_db, repo):
        """单条记录正确写入数据库"""
        records = [{
            "uid": 1,
            "credential_id": 1,
            "provider": "openai",
            "model": "gpt-4",
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "total_tokens": 150,
            "api_calls": 1,
            "cost_estimate": 0.001,
        }]
        await repo.batch_record(records, test_db)

        rows = (await test_db.execute(select(CredentialUsage))).scalars().all()
        assert len(rows) == 1
        row = rows[0]
        assert row.uid == 1
        assert row.credential_id == 1
        assert row.provider == "openai"
        assert row.model == "gpt-4"
        assert row.prompt_tokens == 100
        assert row.completion_tokens == 50
        assert row.total_tokens == 150
        assert row.api_calls == 1
        assert float(row.cost_estimate) == 0.001

    @pytest.mark.asyncio
    async def test_multiple_records(self, test_db, repo):
        """多条记录批量写入，验证数量和内容"""
        records = [
            {
                "uid": 1,
                "provider": "openai",
                "model": "gpt-4",
                "prompt_tokens": 100,
                "completion_tokens": 50,
                "total_tokens": 150,
                "api_calls": 1,
                "cost_estimate": 0.001,
            },
            {
                "uid": 1,
                "provider": "anthropic",
                "model": "claude-3",
                "prompt_tokens": 200,
                "completion_tokens": 80,
                "total_tokens": 280,
                "api_calls": 1,
                "cost_estimate": 0.002,
            },
            {
                "uid": 2,
                "provider": "deepseek",
                "model": "deepseek-v3",
                "prompt_tokens": 50,
                "completion_tokens": 30,
                "total_tokens": 80,
                "api_calls": 1,
                "cost_estimate": 0.0003,
            },
        ]
        await repo.batch_record(records, test_db)

        rows = (await test_db.execute(select(CredentialUsage))).scalars().all()
        assert len(rows) == 3

        providers = {r.provider for r in rows}
        assert providers == {"openai", "anthropic", "deepseek"}

        total = sum(r.total_tokens for r in rows)
        assert total == 510

    @pytest.mark.asyncio
    async def test_credential_id_null(self, test_db, repo):
        """credential_id 为 None（系统默认 Key）时正确写入"""
        records = [{
            "uid": 1,
            "credential_id": None,
            "provider": "openai",
            "prompt_tokens": 10,
            "completion_tokens": 5,
            "total_tokens": 15,
            "api_calls": 1,
            "cost_estimate": 0.0,
        }]
        await repo.batch_record(records, test_db)

        result = await test_db.execute(select(CredentialUsage))
        row = result.scalars().first()
        assert row.credential_id is None
        assert row.total_tokens == 15

    @pytest.mark.asyncio
    async def test_field_integrity_no_default_override(self, test_db, repo):
        """验证 batch_record 不会用 ORM 默认值覆盖传入的显式值"""
        records = [{
            "uid": 1,
            "provider": "custom",
            "model": "custom-model",
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "api_calls": 3,
            "cost_estimate": 0.0,
        }]
        await repo.batch_record(records, test_db)

        result = await test_db.execute(select(CredentialUsage))
        row = result.scalars().first()
        assert row.prompt_tokens == 0
        assert row.completion_tokens == 0
        assert row.total_tokens == 0
        assert row.api_calls == 3  # 非默认值 1，确认我们传的值生效了


class TestRecord:
    """record() 单条写入测试"""

    @pytest_asyncio.fixture(scope="function")
    async def repo(self):
        return UsageRepository()

    @pytest.mark.asyncio
    async def test_single_record_commit(self, test_db, repo):
        """record() 方法正确写入并提交"""
        await repo.record(
            uid=1,
            credential_id=5,
            provider="openai",
            model="gpt-4o",
            prompt_tokens=300,
            completion_tokens=100,
            db=test_db,
            cost_estimate=0.005,
        )

        rows = (await test_db.execute(select(CredentialUsage))).scalars().all()
        assert len(rows) == 1
        row = rows[0]
        assert row.uid == 1
        assert row.credential_id == 5
        assert row.total_tokens == 400
        assert float(row.cost_estimate) == 0.005


class TestAggregations:
    """get_by_model / get_timeseries / get_summary 聚合测试"""

    @pytest_asyncio.fixture(scope="function")
    async def repo(self):
        return UsageRepository()

    @pytest.mark.asyncio
    async def test_get_by_model_groups_correctly(self, test_db, repo):
        """按 model 聚合，返回每个模型的 prompt/completion/cost"""
        records = [
            {"uid": 1, "credential_id": 1, "provider": "dashscope", "model": "qwen3-max",
             "prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150,
             "api_calls": 1, "cost_estimate": 0.01},
            {"uid": 1, "credential_id": 1, "provider": "dashscope", "model": "qwen3-max",
             "prompt_tokens": 200, "completion_tokens": 80, "total_tokens": 280,
             "api_calls": 1, "cost_estimate": 0.02},
            {"uid": 1, "credential_id": 2, "provider": "openai", "model": "gpt-4o",
             "prompt_tokens": 50, "completion_tokens": 30, "total_tokens": 80,
             "api_calls": 1, "cost_estimate": 0.005},
        ]
        await repo.batch_record(records, test_db)

        result = await repo.get_by_model(1, test_db, days=30)
        assert len(result) == 2
        # Ordered by cost desc: qwen3-max (0.03) first
        qwen = next(r for r in result if r.model == "qwen3-max")
        assert qwen.provider == "dashscope"
        assert qwen.total_tokens == 430
        assert qwen.prompt_tokens == 300
        assert qwen.completion_tokens == 130
        assert qwen.api_calls == 2
        assert float(qwen.cost_estimate) == 0.03

    @pytest.mark.asyncio
    async def test_get_timeseries_fills_missing_days(self, test_db, repo):
        """无数据的日期补零，返回 days 个点"""
        result = await repo.get_timeseries(1, test_db, days=7)
        assert len(result) == 7
        # All zeros since no records
        assert all(p.total_tokens == 0 for p in result)
        # Dates are sequential
        from datetime import date, timedelta
        today = date.today()
        assert result[-1].date == today
        assert result[0].date == today - timedelta(days=6)

    @pytest.mark.asyncio
    async def test_get_timeseries_aggregates_by_day(self, test_db, repo):
        """同一天多条记录聚合"""
        records = [
            {"uid": 1, "provider": "openai", "model": "gpt-4o",
             "prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150,
             "api_calls": 1, "cost_estimate": 0.01},
            {"uid": 1, "provider": "openai", "model": "gpt-4o",
             "prompt_tokens": 200, "completion_tokens": 80, "total_tokens": 280,
             "api_calls": 1, "cost_estimate": 0.02},
        ]
        await repo.batch_record(records, test_db)

        result = await repo.get_timeseries(1, test_db, days=7)
        today_point = result[-1]
        assert today_point.total_tokens == 430
        assert today_point.api_calls == 2
        assert float(today_point.cost_estimate) == 0.03

    @pytest.mark.asyncio
    async def test_summary_includes_prompt_completion_and_model(self, test_db, repo):
        """get_summary 返回 prompt/completion 总量、avg_cost、by_model"""
        records = [
            {"uid": 1, "credential_id": 1, "provider": "dashscope", "model": "qwen3-max",
             "prompt_tokens": 1000, "completion_tokens": 500, "total_tokens": 1500,
             "api_calls": 1, "cost_estimate": 0.05},
            {"uid": 1, "credential_id": 2, "provider": "openai", "model": "gpt-4o",
             "prompt_tokens": 200, "completion_tokens": 100, "total_tokens": 300,
             "api_calls": 1, "cost_estimate": 0.003},
        ]
        await repo.batch_record(records, test_db)

        s = await repo.get_summary(1, test_db, days=30)
        assert s.total_tokens == 1800
        assert s.total_prompt_tokens == 1200
        assert s.total_completion_tokens == 600
        assert s.total_api_calls == 2
        assert float(s.total_cost) == 0.053
        assert abs(s.avg_cost_per_call - 0.0265) < 0.0001
        assert len(s.by_model) == 2
        assert len(s.by_provider) == 2


class TestGetUsageRepository:
    """单例工厂函数测试"""

    def test_singleton(self):
        repo1 = get_usage_repository()
        repo2 = get_usage_repository()
        assert repo1 is repo2

    def test_returns_usage_repository(self):
        repo = get_usage_repository()
        assert isinstance(repo, UsageRepository)
