"""
UsageRepository — credential_usage 表的数据库操作

职责：用量记录写入 + 聚合查询（按 provider / credential 分组）。
"""
from datetime import datetime, timezone, timedelta
from typing import Any, Optional

from sqlalchemy import select, func, delete, insert
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models import CredentialUsage, UserCredential
from app.response.credentials import (
    UsageSummary,
    ProviderUsage,
    CredentialUsageItem,
    ModelUsage,
    UsageTimeseriesPoint,
)


class UsageRepository:
    """credential_usage 表的数据访问层"""

    async def record(
        self,
        uid: int,
        credential_id: Optional[int],
        provider: Optional[str],
        model: Optional[str],
        prompt_tokens: int,
        completion_tokens: int,
        db: AsyncSession,
        cost_estimate: float = 0.0,
    ) -> None:
        """记录一次 LLM 调用的 token 用量"""
        total = prompt_tokens + completion_tokens
        entry = CredentialUsage(
            uid=uid,
            credential_id=credential_id,
            provider=provider,
            model=model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total,
            api_calls=1,
            cost_estimate=cost_estimate,
        )
        db.add(entry)
        await db.commit()
        logger.debug(
            f"[USAGE_REPO] recorded provider={provider} tokens={total} "
            f"cost={cost_estimate} credential_id={credential_id} uid={uid}"
        )

    async def get_summary(
        self, uid: int, db: AsyncSession, days: int = 30
    ) -> UsageSummary:
        """获取用户用量汇总（总 token + 调用次数 + 按 provider/credential/model 分布）"""
        since = datetime.now(timezone.utc) - timedelta(days=days)

        total_result = await db.execute(
            select(
                func.coalesce(func.sum(CredentialUsage.total_tokens), 0),
                func.coalesce(func.sum(CredentialUsage.prompt_tokens), 0),
                func.coalesce(func.sum(CredentialUsage.completion_tokens), 0),
                func.coalesce(func.sum(CredentialUsage.api_calls), 0),
                func.coalesce(func.sum(CredentialUsage.cost_estimate), 0.0),
            ).where(
                CredentialUsage.uid == uid,
                CredentialUsage.created_at >= since,
            )
        )
        (
            total_tokens,
            total_prompt,
            total_completion,
            total_api_calls,
            total_cost,
        ) = total_result.one()

        by_provider = await self.get_by_provider(uid, db, days)
        by_credential = await self.get_by_credential(uid, db, days)
        by_model = await self.get_by_model(uid, db, days)

        calls = int(total_api_calls or 0)
        avg_cost = float(total_cost or 0.0) / calls if calls > 0 else 0.0

        return UsageSummary(
            total_tokens=total_tokens,
            total_prompt_tokens=total_prompt,
            total_completion_tokens=total_completion,
            total_api_calls=total_api_calls,
            total_cost=total_cost,
            avg_cost_per_call=round(avg_cost, 6),
            by_provider=by_provider,
            by_credential=by_credential,
            by_model=by_model,
        )

    async def get_by_provider(
        self, uid: int, db: AsyncSession, days: int = 30
    ) -> list[ProviderUsage]:
        """按 provider 聚合用量（饼图数据）"""
        since = datetime.now(timezone.utc) - timedelta(days=days)

        result = await db.execute(
            select(
                CredentialUsage.provider,
                func.sum(CredentialUsage.total_tokens).label("total_tokens"),
                func.sum(CredentialUsage.prompt_tokens).label("prompt_tokens"),
                func.sum(CredentialUsage.completion_tokens).label("completion_tokens"),
                func.sum(CredentialUsage.api_calls).label("api_calls"),
                func.sum(CredentialUsage.cost_estimate).label("cost_estimate"),
            )
            .where(
                CredentialUsage.uid == uid,
                CredentialUsage.created_at >= since,
            )
            .group_by(CredentialUsage.provider)
            .order_by(func.sum(CredentialUsage.total_tokens).desc())
        )
        rows = result.all()
        return [
            ProviderUsage(
                provider=row.provider or "unknown",
                total_tokens=row.total_tokens,
                prompt_tokens=row.prompt_tokens or 0,
                completion_tokens=row.completion_tokens or 0,
                api_calls=row.api_calls,
                cost_estimate=row.cost_estimate or 0.0,
            )
            for row in rows
        ]

    async def get_by_credential(
        self, uid: int, db: AsyncSession, days: int = 30
    ) -> list[CredentialUsageItem]:
        """按 credential 聚合用量（树状图数据），NULL credential_id = 系统默认"""
        since = datetime.now(timezone.utc) - timedelta(days=days)

        result = await db.execute(
            select(
                CredentialUsage.credential_id,
                CredentialUsage.provider,
                func.sum(CredentialUsage.total_tokens).label("total_tokens"),
                func.sum(CredentialUsage.prompt_tokens).label("prompt_tokens"),
                func.sum(CredentialUsage.completion_tokens).label("completion_tokens"),
                func.sum(CredentialUsage.api_calls).label("api_calls"),
                func.sum(CredentialUsage.cost_estimate).label("cost_estimate"),
            )
            .where(
                CredentialUsage.uid == uid,
                CredentialUsage.created_at >= since,
            )
            .group_by(CredentialUsage.credential_id, CredentialUsage.provider)
            .order_by(func.sum(CredentialUsage.total_tokens).desc())
        )
        rows = result.all()

        cred_ids = [r.credential_id for r in rows if r.credential_id is not None]
        name_map: dict[int, str] = {}
        if cred_ids:
            name_result = await db.execute(
                select(UserCredential.id, UserCredential.name).where(
                    UserCredential.id.in_(cred_ids)
                )
            )
            name_map = {row.id: row.name for row in name_result.all()}

        items = []
        for row in rows:
            if row.credential_id is None:
                name = "系统默认"
            else:
                name = name_map.get(row.credential_id, f"Credential #{row.credential_id}")

            items.append(
                CredentialUsageItem(
                    credential_id=row.credential_id,
                    name=name,
                    provider=row.provider or "unknown",
                    total_tokens=row.total_tokens,
                    prompt_tokens=row.prompt_tokens or 0,
                    completion_tokens=row.completion_tokens or 0,
                    api_calls=row.api_calls,
                    cost_estimate=row.cost_estimate or 0.0,
                )
            )
        return items

    async def get_by_model(
        self, uid: int, db: AsyncSession, days: int = 30
    ) -> list[ModelUsage]:
        """按 model 聚合用量（模型维度明细）"""
        since = datetime.now(timezone.utc) - timedelta(days=days)

        result = await db.execute(
            select(
                CredentialUsage.model,
                CredentialUsage.provider,
                func.sum(CredentialUsage.total_tokens).label("total_tokens"),
                func.sum(CredentialUsage.prompt_tokens).label("prompt_tokens"),
                func.sum(CredentialUsage.completion_tokens).label("completion_tokens"),
                func.sum(CredentialUsage.api_calls).label("api_calls"),
                func.sum(CredentialUsage.cost_estimate).label("cost_estimate"),
            )
            .where(
                CredentialUsage.uid == uid,
                CredentialUsage.created_at >= since,
            )
            .group_by(CredentialUsage.model, CredentialUsage.provider)
            .order_by(func.sum(CredentialUsage.cost_estimate).desc())
        )
        rows = result.all()
        return [
            ModelUsage(
                model=row.model or "unknown",
                provider=row.provider or "unknown",
                total_tokens=row.total_tokens,
                prompt_tokens=row.prompt_tokens or 0,
                completion_tokens=row.completion_tokens or 0,
                api_calls=row.api_calls,
                cost_estimate=row.cost_estimate or 0.0,
            )
            for row in rows
        ]

    async def get_timeseries(
        self, uid: int, db: AsyncSession, days: int = 30
    ) -> list[UsageTimeseriesPoint]:
        """按天聚合用量（趋势图数据）。

        返回最近 ``days`` 天每一天的用量；无数据的日期补零，保证前端
        折线图连续。日期使用 UTC。
        """
        since = datetime.now(timezone.utc) - timedelta(days=days)

        result = await db.execute(
            select(
                func.date(CredentialUsage.created_at).label("d"),
                func.sum(CredentialUsage.total_tokens).label("total_tokens"),
                func.sum(CredentialUsage.prompt_tokens).label("prompt_tokens"),
                func.sum(CredentialUsage.completion_tokens).label("completion_tokens"),
                func.sum(CredentialUsage.api_calls).label("api_calls"),
                func.sum(CredentialUsage.cost_estimate).label("cost_estimate"),
            )
            .where(
                CredentialUsage.uid == uid,
                CredentialUsage.created_at >= since,
            )
            .group_by(func.date(CredentialUsage.created_at))
            .order_by(func.date(CredentialUsage.created_at).asc())
        )
        rows = result.all()

        # Normalize date keys: func.date() returns a string in SQLite but a
        # date object in MySQL.  Coerce everything to date for consistent
        # lookup against the fill loop below.
        from datetime import date as _date

        def _to_date(v: object) -> _date:
            if isinstance(v, _date):
                return v
            if isinstance(v, str):
                return _date.fromisoformat(v[:10])
            if isinstance(v, datetime):
                return v.date()
            raise TypeError(f"unexpected date type: {type(v)}")

        day_map: dict[_date, Any] = {_to_date(r.d): r for r in rows}

        # Fill missing days with zeros for a continuous chart.
        points: list[UsageTimeseriesPoint] = []
        today = datetime.now(timezone.utc).date()
        for i in range(days):
            d = today - timedelta(days=days - 1 - i)
            row = day_map.get(d)
            if row is not None:
                points.append(
                    UsageTimeseriesPoint(
                        date=d,
                        total_tokens=row.total_tokens or 0,
                        prompt_tokens=row.prompt_tokens or 0,
                        completion_tokens=row.completion_tokens or 0,
                        api_calls=row.api_calls or 0,
                        cost_estimate=float(row.cost_estimate or 0.0),
                    )
                )
            else:
                points.append(
                    UsageTimeseriesPoint(
                        date=d,
                        total_tokens=0,
                        prompt_tokens=0,
                        completion_tokens=0,
                        api_calls=0,
                        cost_estimate=0.0,
                    )
                )
        return points

    async def batch_record(
        self, records: list[dict], db: AsyncSession
    ) -> None:
        """批量 INSERT 用量记录（单条 SQL，单次事务）"""
        if not records:
            return
        stmt = insert(CredentialUsage).values(records)
        await db.execute(stmt)
        await db.commit()
        logger.debug(f"[USAGE_REPO] batch inserted {len(records)} usage records")

    async def cleanup_old(self, db: AsyncSession, days: int = 90) -> int:
        """清理超过 N 天的用量记录，返回删除行数"""
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        result = await db.execute(
            delete(CredentialUsage).where(CredentialUsage.created_at < cutoff)
        )
        await db.commit()
        deleted = result.rowcount
        if deleted:
            logger.info(f"[USAGE_REPO] cleaned up {deleted} old usage records")
        return deleted


# 模块级单例
_usage_repo: Optional[UsageRepository] = None


def get_usage_repository() -> UsageRepository:
    """获取 UsageRepository 单例"""
    global _usage_repo
    if _usage_repo is None:
        _usage_repo = UsageRepository()
    return _usage_repo
