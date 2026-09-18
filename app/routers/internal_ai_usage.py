"""内部端点：AI 网关 usage-logger 插件上报请求级用量（plan/1.0.11 M4）。

鉴权模型与 /internal/quiz/* 一致：APISIX key-auth 网关层保护，backend 不自验。
数据落 ``ai_gateway_usage``（网关侧账本），与 ``credential_usage`` 每日对账。
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.database import get_db_context
from app.repository.ai_usage_repository import record_gateway_usage

router = APIRouter(prefix="/internal/ai-usage", tags=["internal-ai-usage"])


class GatewayUsageReport(BaseModel):
    request_id: str = Field(default="", max_length=64)
    uid: int | None = None
    model: str = Field(default="unknown", max_length=64)
    purpose: str = Field(default="", max_length=32)
    prompt_tokens: int = Field(default=0, ge=0)
    completion_tokens: int = Field(default=0, ge=0)
    status: str = Field(default="", max_length=24)


@router.post("")
async def report_gateway_usage(report: GatewayUsageReport) -> dict:
    if not report.request_id:
        # request_id 是对账关联键，缺了这条记录就没法与 credential_usage 关联
        raise HTTPException(status_code=422, detail="request_id is required")
    record = report.model_dump()
    async with get_db_context() as db:
        await record_gateway_usage(record, db)
    return {"recorded": True}
