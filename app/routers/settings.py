"""
用户 API Key 配置接口

提供 LLM Credential、Embedding 配置、ASR 配置的完整 CRUD。
所有接口需 Bearer token 认证，响应中绝不包含完整 Key。
"""
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.database import get_db
from app.response.credentials import (
    EmbeddingConfigResponse,
    ASRConfigResponse,
    ApiKeyStatusResponse,
    ApiKeySetRequest,
    EmbeddingConfigCreate,
    EmbeddingConfigUpdate,
    ASRConfigCreate,
    ASRConfigUpdate,
)
from app.routers.auth import get_current_uid
from app.services.llm.api_key_manager import ApiKeyManager

router = APIRouter(prefix="/settings", tags=["settings"])


def _get_manager() -> ApiKeyManager:
    from app.main import app
    m: ApiKeyManager = app.state.api_key_manager
    if not m:
        raise HTTPException(status_code=503, detail="API Key 配置功能暂不可用")
    return m


# ═══════════════════════════════════════════════════════════
# 兼容旧接口
# ═══════════════════════════════════════════════════════════

@router.get("/credentials/status", response_model=ApiKeyStatusResponse)
async def get_credentials_status(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    manager = _get_manager()
    return ApiKeyStatusResponse(**await manager.get_status(uid, db))


@router.post("/credentials")
async def set_credentials(
    req: ApiKeySetRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    has_any = any([
        req.llm_api_key, req.llm_base_url, req.llm_model,
        req.embedding_api_key, req.embedding_base_url, req.embedding_model,
        req.asr_api_key, req.asr_base_url, req.asr_model,
    ])
    if not has_any:
        raise HTTPException(status_code=400, detail="请至少填写一个配置项")
    try:
        await _get_manager().set_credentials(
            uid=uid, db=db,
            llm_key=req.llm_api_key, llm_base_url=req.llm_base_url, llm_model=req.llm_model,
            embedding_key=req.embedding_api_key, embedding_base_url=req.embedding_base_url, embedding_model=req.embedding_model,
            asr_key=req.asr_api_key, asr_base_url=req.asr_base_url, asr_model=req.asr_model,
        )
        return {"message": "API Key 配置已保存"}
    except Exception:
        logger.exception("[SETTINGS] save failed")
        raise HTTPException(status_code=500, detail="配置保存失败")


@router.delete("/credentials")
async def delete_credentials(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    await _get_manager().delete_credentials(uid, db)
    return {"message": "已删除自定义 API Key，将使用系统默认配置（可能产生费用）"}


# ═══════════════════════════════════════════════════════════
# Embedding 配置 CRUD
# ═══════════════════════════════════════════════════════════

@router.get("/embedding-configs", response_model=list[EmbeddingConfigResponse])
async def list_embedding_configs(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    return await _get_manager().list_embedding_configs(uid, db)


@router.post("/embedding-configs", response_model=EmbeddingConfigResponse, status_code=201)
async def create_embedding_config(
    req: EmbeddingConfigCreate,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    if not req.api_key:
        raise HTTPException(status_code=400, detail="API Key 不能为空")
    if req.provider not in ("openai", "dashscope", "custom"):
        raise HTTPException(status_code=400, detail=f"不支持的 provider: {req.provider}")
    return await _get_manager().create_embedding_config(
        uid=uid, name=req.name, provider=req.provider, api_key=req.api_key,
        base_url=req.base_url, model=req.model, is_default=req.is_default, db=db,
    )


@router.patch("/embedding-configs/{config_id}", response_model=EmbeddingConfigResponse)
async def update_embedding_config(
    config_id: int,
    req: EmbeddingConfigUpdate,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    result = await _get_manager().update_embedding_config(
        uid=uid, config_id=config_id, db=db,
        name=req.name, api_key=req.api_key, base_url=req.base_url,
        model=req.model, is_default=req.is_default,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Embedding 配置不存在")
    return result


@router.delete("/embedding-configs/{config_id}")
async def delete_embedding_config(
    config_id: int,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    if not await _get_manager().delete_embedding_config(uid, config_id, db):
        raise HTTPException(status_code=404, detail="Embedding 配置不存在")
    return {"message": "已删除"}


@router.post("/embedding-configs/{config_id}/default")
async def set_default_embedding_config(
    config_id: int,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    if not await _get_manager().set_default_embedding_config(uid, config_id, db):
        raise HTTPException(status_code=404, detail="Embedding 配置不存在")
    return {"message": "已设为默认"}


@router.post("/embedding-configs/{config_id}/test")
async def test_embedding_config(
    config_id: int,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Test embedding config connectivity."""
    from app.repository.embedding_config_repository import get_embedding_config_repository
    repo = get_embedding_config_repository()
    record = await repo.get_by_id(config_id, db)
    if not record or record.uid != uid:
        raise HTTPException(status_code=404, detail="Embedding 配置不存在")

    mgr = _get_manager()
    try:
        api_key = mgr._decrypt(record.api_key_encrypted)
    except Exception:
        raise HTTPException(status_code=500, detail="无法解密 API Key")

    from app.services.llm.config_tester import ConfigTester
    result = await ConfigTester().test_embedding(
        api_key=api_key,
        base_url=record.base_url or "https://api.openai.com/v1",
        model=record.model or "text-embedding-3-small",
    )
    await repo.update_test_result(config_id, db, result.status, result.error)
    return {"status": result.status, "error": result.error, "latency_ms": result.latency_ms}


# ═══════════════════════════════════════════════════════════
# ASR 配置 CRUD
# ═══════════════════════════════════════════════════════════

@router.get("/asr-configs", response_model=list[ASRConfigResponse])
async def list_asr_configs(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    return await _get_manager().list_asr_configs(uid, db)


@router.post("/asr-configs", response_model=ASRConfigResponse, status_code=201)
async def create_asr_config(
    req: ASRConfigCreate,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    if not req.api_key:
        raise HTTPException(status_code=400, detail="API Key 不能为空")
    if req.provider not in ("dashscope", "openai", "custom"):
        raise HTTPException(status_code=400, detail=f"不支持的 provider: {req.provider}")
    return await _get_manager().create_asr_config(
        uid=uid, name=req.name, provider=req.provider, api_key=req.api_key,
        base_url=req.base_url, model=req.model, is_default=req.is_default, db=db,
    )


@router.patch("/asr-configs/{config_id}", response_model=ASRConfigResponse)
async def update_asr_config(
    config_id: int,
    req: ASRConfigUpdate,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    result = await _get_manager().update_asr_config(
        uid=uid, config_id=config_id, db=db,
        name=req.name, api_key=req.api_key, base_url=req.base_url,
        model=req.model, is_default=req.is_default,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="ASR 配置不存在")
    return result


@router.delete("/asr-configs/{config_id}")
async def delete_asr_config(
    config_id: int,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    if not await _get_manager().delete_asr_config(uid, config_id, db):
        raise HTTPException(status_code=404, detail="ASR 配置不存在")
    return {"message": "已删除"}


@router.post("/asr-configs/{config_id}/default")
async def set_default_asr_config(
    config_id: int,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    if not await _get_manager().set_default_asr_config(uid, config_id, db):
        raise HTTPException(status_code=404, detail="ASR 配置不存在")
    return {"message": "已设为默认"}


@router.post("/asr-configs/{config_id}/test")
async def test_asr_config(
    config_id: int,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Test ASR config connectivity."""
    from app.repository.asr_config_repository import get_asr_config_repository
    repo = get_asr_config_repository()
    record = await repo.get_by_id(config_id, db)
    if not record or record.uid != uid:
        raise HTTPException(status_code=404, detail="ASR 配置不存在")

    mgr = _get_manager()
    try:
        api_key = mgr._decrypt(record.api_key_encrypted)
    except Exception:
        raise HTTPException(status_code=500, detail="无法解密 API Key")

    from app.services.llm.config_tester import ConfigTester
    result = await ConfigTester().test_asr(
        api_key=api_key,
        base_url=record.base_url or "https://dashscope.aliyuncs.com/api/v1",
    )
    await repo.update_test_result(config_id, db, result.status, result.error)
    return {"status": result.status, "error": result.error, "latency_ms": result.latency_ms}
