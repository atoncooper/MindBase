"""
计费/用量查询接口

提供用户 LLM 用量的聚合查询：
- 总 token / 调用次数
- 按 Provider 分布（饼图数据）
- 按 Credential 分布（树状图数据）
"""
from fastapi import APIRouter, Query, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.response.credentials import UsageSummary
from app.routers.auth import get_current_uid
from app.repository.usage_repository import get_usage_repository

router = APIRouter(prefix="/billing", tags=["billing"])


@router.get("/summary", response_model=UsageSummary)
async def get_usage_summary(
    uid: int = Depends(get_current_uid),
    days: int = Query(30, description="统计天数", ge=1, le=365),
    db: AsyncSession = Depends(get_db),
):
    """获取用量汇总（总 token + 调用次数 + 按 provider/credential 分布）。"""
    repo = get_usage_repository()
    return await repo.get_summary(uid, db, days=days)


@router.get("/by-provider")
async def get_usage_by_provider(
    uid: int = Depends(get_current_uid),
    days: int = Query(30, description="统计天数", ge=1, le=365),
    db: AsyncSession = Depends(get_db),
):
    """按 Provider 聚合用量（饼图数据）。"""
    repo = get_usage_repository()
    return await repo.get_by_provider(uid, db, days=days)


@router.get("/by-credential")
async def get_usage_by_credential(
    uid: int = Depends(get_current_uid),
    days: int = Query(30, description="统计天数", ge=1, le=365),
    db: AsyncSession = Depends(get_db),
):
    """按 Credential 聚合用量（树状图数据）。"""
    repo = get_usage_repository()
    return await repo.get_by_credential(uid, db, days=days)
