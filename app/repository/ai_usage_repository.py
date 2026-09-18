"""AI 计量账单仓储（plan/1.0.11 §6.5）。

- :class:`AIGatewayUsage` — 网关侧请求级流水（Higress usage-logger 插件经
  ``POST /internal/ai-usage`` 上报），与 ``credential_usage`` 构成双账本对账。
- :class:`AIUsageDaily` — ``credential_usage`` 的持久日聚合（单价快照内嵌，
  改价不重算历史；金额一律 long 分）。
- :class:`AIPriceConfig` — 计价配置（effective_from 版本化；首次 rollup 时从
  ``pricing.py`` 的内置价目表播种，此后以表为准）。

rollup 由 backend lifespan 内的周期任务驱动（``start_usage_rollup_loop``），
聚合「昨天 + 今天」两天，容忍迟到写入；幂等（同维度覆盖更新）。
"""

from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone

from loguru import logger
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session_factory
from app.models import AIGatewayUsage, AIPriceConfig, AIUsageDaily, CredentialUsage

_PRICE_SEED_EFFECTIVE_FROM = date(2026, 1, 1)
_ROLLUP_INTERVAL_SECONDS = 6 * 3600  # 6h：覆盖跨天边界与迟到写入


# ---------------------------------------------------------------------------
# 网关侧流水
# ---------------------------------------------------------------------------

async def record_gateway_usage(record: dict, db: AsyncSession) -> None:
    """落一条网关侧请求级流水（usage-logger 上报）。"""
    db.add(AIGatewayUsage(**record))
    await db.commit()


# ---------------------------------------------------------------------------
# 计价
# ---------------------------------------------------------------------------

async def bootstrap_prices_if_empty(db: AsyncSession) -> int:
    """价目表为空时从 pricing.py 内置表播种（元/百万 → 分/百万，×100）。"""
    existing = (await db.execute(select(func.count()).select_from(AIPriceConfig))).scalar() or 0
    if existing:
        return 0
    from app.services.llm.pricing import _PRICES

    count = 0
    for provider, models in _PRICES.items():
        for model, entry in models.items():
            db.add(
                AIPriceConfig(
                    provider=provider,
                    model=model,
                    input_per_m=int(round((entry.input_price or 0) * 100)),
                    output_per_m=int(round((entry.output_price or 0) * 100)),
                    asr_per_minute=0,
                    effective_from=_PRICE_SEED_EFFECTIVE_FROM,
                    enabled=True,
                )
            )
            count += 1
    await db.commit()
    if count:
        logger.info(f"[AI_USAGE] price config seeded: {count} entries from pricing.py")
    return count


async def get_price(
    db: AsyncSession, stat_date: date, provider: str, model: str
) -> tuple[int, int]:
    """取 (input_per_m, output_per_m)：provider+model 精确匹配的最新生效价，缺省 (0, 0)。"""
    stmt = (
        select(AIPriceConfig)
        .where(
            AIPriceConfig.provider == provider,
            AIPriceConfig.model == model,
            AIPriceConfig.enabled.is_(True),
            AIPriceConfig.effective_from <= stat_date,
        )
        .order_by(AIPriceConfig.effective_from.desc())
        .limit(1)
    )
    row = (await db.execute(stmt)).scalar_one_or_none()
    if row is None:
        # model 兜底：任意 provider 下同名模型（BYOK 端点/provider 标签漂移容错）
        stmt2 = (
            select(AIPriceConfig)
            .where(
                AIPriceConfig.model == model,
                AIPriceConfig.enabled.is_(True),
                AIPriceConfig.effective_from <= stat_date,
            )
            .order_by(AIPriceConfig.effective_from.desc())
            .limit(1)
        )
        row = (await db.execute(stmt2)).scalar_one_or_none()
    if row is None:
        return 0, 0
    return row.input_per_m, row.output_per_m


# ---------------------------------------------------------------------------
# rollup：credential_usage → ai_usage_daily
# ---------------------------------------------------------------------------

def _cost_fen(prompt_tokens: int, completion_tokens: int, in_per_m: int, out_per_m: int) -> int:
    """token → 分（long 分规范）。单价为分/百万 token。"""
    cost = (prompt_tokens / 1_000_000) * in_per_m + (completion_tokens / 1_000_000) * out_per_m
    return int(round(cost))


async def rollup_daily(db: AsyncSession, target: date) -> int:
    """聚合 target 当天的 credential_usage → ai_usage_daily（幂等覆盖）。"""
    start = datetime(target.year, target.month, target.day, tzinfo=timezone.utc)
    end = start + timedelta(days=1)

    stmt = (
        select(
            CredentialUsage.uid,
            func.coalesce(CredentialUsage.provider, "unknown").label("provider"),
            func.coalesce(CredentialUsage.model, "unknown").label("model"),
            func.coalesce(func.nullif(CredentialUsage.purpose, ""), "unknown").label("purpose"),
            func.count().label("requests"),
            func.coalesce(func.sum(CredentialUsage.prompt_tokens), 0).label("prompt_tokens"),
            func.coalesce(func.sum(CredentialUsage.completion_tokens), 0).label("completion_tokens"),
        )
        .where(CredentialUsage.created_at >= start, CredentialUsage.created_at < end)
        .group_by(
            CredentialUsage.uid,
            func.coalesce(CredentialUsage.provider, "unknown"),
            func.coalesce(CredentialUsage.model, "unknown"),
            func.coalesce(func.nullif(CredentialUsage.purpose, ""), "unknown"),
        )
    )
    rows = (await db.execute(stmt)).all()
    if not rows:
        return 0

    count = 0
    for row in rows:
        in_per_m, out_per_m = await get_price(db, target, row.provider, row.model)
        cost = _cost_fen(int(row.prompt_tokens), int(row.completion_tokens), in_per_m, out_per_m)
        existing = (
            await db.execute(
                select(AIUsageDaily).where(
                    AIUsageDaily.uid == row.uid,
                    AIUsageDaily.stat_date == target,
                    AIUsageDaily.provider == row.provider,
                    AIUsageDaily.model == row.model,
                    AIUsageDaily.purpose == row.purpose,
                )
            )
        ).scalar_one_or_none()
        if existing is None:
            db.add(
                AIUsageDaily(
                    uid=row.uid,
                    stat_date=target,
                    provider=row.provider,
                    model=row.model,
                    purpose=row.purpose,
                    requests=int(row.requests),
                    prompt_tokens=int(row.prompt_tokens),
                    completion_tokens=int(row.completion_tokens),
                    unit_price_in=in_per_m,
                    unit_price_out=out_per_m,
                    cost=cost,
                )
            )
        else:
            existing.requests = int(row.requests)
            existing.prompt_tokens = int(row.prompt_tokens)
            existing.completion_tokens = int(row.completion_tokens)
            existing.unit_price_in = in_per_m
            existing.unit_price_out = out_per_m
            existing.cost = cost
            existing.updated_at = datetime.now(timezone.utc)
        count += 1
    await db.commit()
    return count


async def run_rollup_once(days_back: int = 1) -> int:
    """聚合昨天+今天（迟到写入容忍），返回聚合维度行数。"""
    today = datetime.now(timezone.utc).date()
    total = 0
    async with async_session_factory() as db:
        await bootstrap_prices_if_empty(db)
        for offset in range(days_back + 1):
            target = today - timedelta(days=offset)
            try:
                total += await rollup_daily(db, target)
            except Exception as e:  # noqa: BLE001
                logger.error(f"[AI_USAGE] rollup failed for {target}: {e}")
    if total:
        logger.info(f"[AI_USAGE] rollup done: {total} dimension rows")
    return total


async def start_usage_rollup_loop() -> asyncio.Task:
    """lifespan 启动的周期任务：启动即跑一次，此后每 6h 一次。"""

    async def _loop() -> None:
        while True:
            try:
                await run_rollup_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("[AI_USAGE] rollup loop iteration failed")
            await asyncio.sleep(_ROLLUP_INTERVAL_SECONDS)

    return asyncio.create_task(_loop(), name="ai-usage-rollup")
