"""
API Key Manager — 用户多 Provider API Key 的加密存储、缓存和动态解析

职责：
1. AES-256-GCM 加密/解密
2. 多 credential CRUD（list / create / update / delete / set_default）
3. 通过 CredentialCacheBackend 缓存 credential 数据
4. 提供 get_default_credential_sync 接口供 chat.py 同步调用
5. Key mask 展示

缓存策略：
- 本期使用 LocalMemoryCache（dict + TTL 5 分钟）
- 后续可替换为 RedisCache（实现 CredentialCacheBackend 接口即可）
- 缓存 key = str(uid)，存储该用户的所有 credential
"""
import base64
import os
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.repository.credential_repository import (
    CredentialRepository,
    get_credential_repository,
)
from app.repository.usage_repository import (
    UsageRepository,
    get_usage_repository,
)
from app.repository.embedding_config_repository import (
    EmbeddingConfigRepository,
    get_embedding_config_repository,
)
from app.repository.asr_config_repository import (
    ASRConfigRepository,
    get_asr_config_repository,
)
from app.services.llm.credential_cache import (
    CredentialCacheBackend,
    CredentialCacheData,
    CacheEntry,
    LocalMemoryCache,
)

from app.response.credentials import (
    CredentialResponse,
    EmbeddingConfigResponse,
    ASRConfigResponse,
)


@dataclass
class UserCredentials:
    """用户凭据（临时持有，用完即释放）"""
    api_key: str
    base_url: Optional[str] = None
    model: Optional[str] = None
    credential_id: Optional[int] = None  # None = 系统默认


class ApiKeyManager:
    """
    用户多 Provider API Key 管理器

    关键安全原则：
    - 数据库存密文
    - 缓存只存密文
    - 使用时临时解密，用完即释放
    """

    CACHE_TTL = 300  # 5 分钟

    def __init__(
        self,
        encryption_key_b64: Optional[str] = None,
        cache_backend: Optional[CredentialCacheBackend] = None,
        credential_repo: Optional[CredentialRepository] = None,
        usage_repo: Optional[UsageRepository] = None,
        embedding_config_repo: Optional[EmbeddingConfigRepository] = None,
        asr_config_repo: Optional[ASRConfigRepository] = None,
    ):
        self._cache = cache_backend or LocalMemoryCache()
        self._cred_repo = credential_repo or get_credential_repository()
        self._usage_repo = usage_repo or get_usage_repository()
        self._emb_repo = embedding_config_repo or get_embedding_config_repository()
        self._asr_repo = asr_config_repo or get_asr_config_repository()
        self._enabled = True

        if encryption_key_b64:
            try:
                key_bytes = base64.b64decode(encryption_key_b64)
                if len(key_bytes) != 32:
                    raise ValueError(f"Key is {len(key_bytes)} bytes, expected 32")
                self._aesgcm = AESGCM(key_bytes)
                logger.info("[API_KEY_MANAGER] initialized with AES-256-GCM encryption")
            except Exception as e:
                self._aesgcm = None
                logger.warning(
                    f"[API_KEY_MANAGER] invalid encryption key ({e}), "
                    "API keys will be stored WITHOUT encryption"
                )
        else:
            self._aesgcm = None
            logger.warning(
                "[API_KEY_MANAGER] encryption key not configured, "
                "API keys will be stored WITHOUT encryption"
            )

    # ═══════════════════════════════════════════════════════════
    # 多 Credential CRUD
    # ═══════════════════════════════════════════════════════════

    async def list_credentials(
        self, uid: int, db: AsyncSession
    ) -> list[CredentialResponse]:
        """列出用户全部 credential（Key masked）"""
        records = await self._cred_repo.list_by_uid(uid, db)
        return [
            CredentialResponse(
                id=r.id,
                name=r.name,
                provider=r.provider,
                masked_key=self._mask_key(self._decrypt(r.api_key_encrypted)),
                base_url=r.base_url,
                default_model=r.default_model,
                is_default=r.is_default,
                created_at=r.created_at,
                updated_at=r.updated_at,
                last_test_status=r.last_test_status,
                last_test_error=r.last_test_error,
                last_test_at=r.last_test_at,
            )
            for r in records
        ]

    async def create_credential(
        self,
        uid: int,
        name: str,
        provider: str,
        api_key: str,
        base_url: Optional[str],
        default_model: Optional[str],
        is_default: bool,
        db: AsyncSession,
    ) -> CredentialResponse:
        """新建 credential，同时刷新缓存"""
        record = await self._cred_repo.create(
            uid=uid,
            name=name,
            provider=provider,
            api_key_encrypted=self._encrypt(api_key),
            base_url=base_url,
            default_model=default_model,
            is_default=is_default,
            db=db,
        )
        await self._refresh_cache(uid, db)
        return CredentialResponse(
            id=record.id,
            name=record.name,
            provider=record.provider,
            masked_key=self._mask_key(api_key),
            base_url=record.base_url,
            default_model=record.default_model,
            is_default=record.is_default,
            created_at=record.created_at,
            updated_at=record.updated_at,
        )

    async def update_credential(
        self,
        uid: int,
        credential_id: int,
        name: Optional[str] = None,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        default_model: Optional[str] = None,
        is_default: Optional[bool] = None,
        db: AsyncSession = None,
    ) -> Optional[CredentialResponse]:
        """部分更新 credential"""
        api_key_encrypted = self._encrypt(api_key) if api_key else None

        record = await self._cred_repo.update(
            uid=uid,
            credential_id=credential_id,
            db=db,
            name=name,
            api_key_encrypted=api_key_encrypted,
            base_url=base_url,
            default_model=default_model,
            is_default=is_default,
        )
        if record is None:
            return None

        await self._refresh_cache(uid, db)
        return CredentialResponse(
            id=record.id,
            name=record.name,
            provider=record.provider,
            masked_key=self._mask_key(self._decrypt(record.api_key_encrypted)),
            base_url=record.base_url,
            default_model=record.default_model,
            is_default=record.is_default,
            created_at=record.created_at,
            updated_at=record.updated_at,
            last_test_status=record.last_test_status,
            last_test_error=record.last_test_error,
            last_test_at=record.last_test_at,
        )

    async def delete_credential(
        self, uid: int, credential_id: int, db: AsyncSession
    ) -> bool:
        """删除 credential"""
        deleted = await self._cred_repo.delete(uid, credential_id, db)
        if deleted:
            await self._refresh_cache(uid, db)
        return deleted

    async def set_default(
        self, uid: int, credential_id: int, db: AsyncSession
    ) -> bool:
        """设为默认 credential"""
        ok = await self._cred_repo.set_default(uid, credential_id, db)
        if ok:
            await self._refresh_cache(uid, db)
        return ok

    async def get_default_credential(
        self, uid: int, db: AsyncSession
    ) -> Optional[UserCredentials]:
        """异步获取用户默认 LLM credential"""
        cache_key = str(uid)
        entry = await self._get_cache_entry(uid, db)
        entry = self._normalize_entry(entry)
        if entry is None or entry.default_credential_id is None:
            return None

        cred_data = entry.credentials.get(entry.default_credential_id)
        if cred_data is None:
            return None

        try:
            return UserCredentials(
                api_key=self._decrypt(cred_data.api_key_encrypted),
                base_url=cred_data.base_url,
                model=cred_data.default_model,
                credential_id=entry.default_credential_id,
            )
        except Exception as e:
            logger.error(f"[API_KEY_MANAGER] decrypt default cred failed: {e}")
            return None

    # ═══════════════════════════════════════════════════════════
    # 同步方法（供 chat.py 的同步 _get_llm 使用）
    # ═══════════════════════════════════════════════════════════

    def get_default_credential_sync(
        self, uid: Optional[int]
    ) -> Optional[UserCredentials]:
        """
        同步获取用户默认 LLM credential（仅读缓存，不查数据库）。

        用于 chat.py 的同步 _get_llm() 函数。
        缓存未命中时返回 None，调用方应使用系统默认 Key。
        """
        import asyncio

        if uid is None or not self._enabled:
            return None

        cache_key = str(uid)
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                future = asyncio.run_coroutine_threadsafe(
                    self._cache.get(cache_key), loop
                )
                entry = future.result(timeout=0.5)
            else:
                entry = loop.run_until_complete(self._cache.get(cache_key))
        except RuntimeError:
            return None
        except Exception:
            return None

        entry = self._normalize_entry(entry)
        if entry is None or entry.default_credential_id is None:
            return None

        cred_data = entry.credentials.get(entry.default_credential_id)
        if cred_data is None:
            return None

        try:
            return UserCredentials(
                api_key=self._decrypt(cred_data.api_key_encrypted),
                base_url=cred_data.base_url,
                model=cred_data.default_model,
                credential_id=entry.default_credential_id,
            )
        except Exception as e:
            logger.error(f"[API_KEY_MANAGER] sync decrypt failed: {e}")
            return None

    async def preload_credentials(self, uid: int, db: AsyncSession) -> None:
        """预热缓存（在请求入口的异步上下文中调用）"""
        if not self._enabled:
            return
        await self._get_cache_entry(uid, db)

    # ═══════════════════════════════════════════════════════════
    # Embedding 配置 CRUD
    # ═══════════════════════════════════════════════════════════

    async def list_embedding_configs(
        self, uid: int, db: AsyncSession
    ) -> list[EmbeddingConfigResponse]:
        records = await self._emb_repo.list_by_uid(uid, db)
        return [
            EmbeddingConfigResponse(
                id=r.id, name=r.name, provider=r.provider,
                masked_key=self._mask_key(self._decrypt(r.api_key_encrypted)),
                base_url=r.base_url, model=r.model,
                is_default=r.is_default,
                created_at=r.created_at, updated_at=r.updated_at,
                last_test_status=r.last_test_status,
                last_test_error=r.last_test_error,
                last_test_at=r.last_test_at,
            )
            for r in records
        ]

    async def create_embedding_config(
        self, uid: int, name: str, provider: str, api_key: str,
        base_url: Optional[str], model: Optional[str], is_default: bool,
        db: AsyncSession,
    ) -> EmbeddingConfigResponse:
        record = await self._emb_repo.create(
            uid=uid, name=name, provider=provider,
            api_key_encrypted=self._encrypt(api_key),
            base_url=base_url, model=model, is_default=is_default, db=db,
        )
        return EmbeddingConfigResponse(
            id=record.id, name=record.name, provider=record.provider,
            masked_key=self._mask_key(api_key),
            base_url=record.base_url, model=record.model,
            is_default=record.is_default,
            created_at=record.created_at, updated_at=record.updated_at,
        )

    async def update_embedding_config(
        self, uid: int, config_id: int, db: AsyncSession,
        name: Optional[str] = None, api_key: Optional[str] = None,
        base_url: Optional[str] = None, model: Optional[str] = None,
        is_default: Optional[bool] = None,
    ) -> Optional[EmbeddingConfigResponse]:
        record = await self._emb_repo.update(
            uid=uid, config_id=config_id, db=db, name=name,
            api_key_encrypted=self._encrypt(api_key) if api_key else None,
            base_url=base_url, model=model, is_default=is_default,
        )
        if record is None:
            return None
        return EmbeddingConfigResponse(
            id=record.id, name=record.name, provider=record.provider,
            masked_key=self._mask_key(self._decrypt(record.api_key_encrypted)),
            base_url=record.base_url, model=record.model,
            is_default=record.is_default,
            created_at=record.created_at, updated_at=record.updated_at,
            last_test_status=record.last_test_status,
            last_test_error=record.last_test_error,
            last_test_at=record.last_test_at,
        )

    async def delete_embedding_config(
        self, uid: int, config_id: int, db: AsyncSession
    ) -> bool:
        return await self._emb_repo.delete(uid, config_id, db)

    async def set_default_embedding_config(
        self, uid: int, config_id: int, db: AsyncSession
    ) -> bool:
        return await self._emb_repo.set_default(uid, config_id, db)

    async def get_default_embedding_credentials(
        self, uid: Optional[int], db: AsyncSession
    ) -> Optional[UserCredentials]:
        if uid is None or not self._enabled:
            return None
        record = await self._emb_repo.get_default(uid, db)
        if not record:
            return None
        try:
            return UserCredentials(
                api_key=self._decrypt(record.api_key_encrypted),
                base_url=record.base_url,
                model=record.model,
            )
        except Exception as e:
            logger.error(f"[API_KEY_MANAGER] decrypt embedding key failed: {e}")
            return None

    # ═══════════════════════════════════════════════════════════
    # ASR 配置 CRUD
    # ═══════════════════════════════════════════════════════════

    async def list_asr_configs(
        self, uid: int, db: AsyncSession
    ) -> list[ASRConfigResponse]:
        records = await self._asr_repo.list_by_uid(uid, db)
        return [
            ASRConfigResponse(
                id=r.id, name=r.name, provider=r.provider,
                masked_key=self._mask_key(self._decrypt(r.api_key_encrypted)),
                base_url=r.base_url, model=r.model,
                is_default=r.is_default,
                created_at=r.created_at, updated_at=r.updated_at,
                last_test_status=r.last_test_status,
                last_test_error=r.last_test_error,
                last_test_at=r.last_test_at,
            )
            for r in records
        ]

    async def create_asr_config(
        self, uid: int, name: str, provider: str, api_key: str,
        base_url: Optional[str], model: Optional[str], is_default: bool,
        db: AsyncSession,
    ) -> ASRConfigResponse:
        record = await self._asr_repo.create(
            uid=uid, name=name, provider=provider,
            api_key_encrypted=self._encrypt(api_key),
            base_url=base_url, model=model, is_default=is_default, db=db,
        )
        return ASRConfigResponse(
            id=record.id, name=record.name, provider=record.provider,
            masked_key=self._mask_key(api_key),
            base_url=record.base_url, model=record.model,
            is_default=record.is_default,
            created_at=record.created_at, updated_at=record.updated_at,
        )

    async def update_asr_config(
        self, uid: int, config_id: int, db: AsyncSession,
        name: Optional[str] = None, api_key: Optional[str] = None,
        base_url: Optional[str] = None, model: Optional[str] = None,
        is_default: Optional[bool] = None,
    ) -> Optional[ASRConfigResponse]:
        record = await self._asr_repo.update(
            uid=uid, config_id=config_id, db=db, name=name,
            api_key_encrypted=self._encrypt(api_key) if api_key else None,
            base_url=base_url, model=model, is_default=is_default,
        )
        if record is None:
            return None
        return ASRConfigResponse(
            id=record.id, name=record.name, provider=record.provider,
            masked_key=self._mask_key(self._decrypt(record.api_key_encrypted)),
            base_url=record.base_url, model=record.model,
            is_default=record.is_default,
            created_at=record.created_at, updated_at=record.updated_at,
        )

    async def delete_asr_config(
        self, uid: int, config_id: int, db: AsyncSession
    ) -> bool:
        return await self._asr_repo.delete(uid, config_id, db)

    async def set_default_asr_config(
        self, uid: int, config_id: int, db: AsyncSession
    ) -> bool:
        return await self._asr_repo.set_default(uid, config_id, db)

    # ═══════════════════════════════════════════════════════════
    # 兼容旧 settings 接口
    # ═══════════════════════════════════════════════════════════

    async def get_llm_credentials(
        self, uid: Optional[int], db: AsyncSession
    ) -> Optional[UserCredentials]:
        if uid is None:
            return None
        return await self.get_default_credential(uid, db)

    async def set_credentials(
        self, uid: int, db: AsyncSession = None,
        llm_key: Optional[str] = None, llm_base_url: Optional[str] = None,
        llm_model: Optional[str] = None,
        embedding_key: Optional[str] = None, embedding_base_url: Optional[str] = None,
        embedding_model: Optional[str] = None,
        asr_key: Optional[str] = None, asr_base_url: Optional[str] = None,
        asr_model: Optional[str] = None,
    ) -> None:
        """兼容旧 settings 写入 — 拆分为独立的 embed / asr 配置"""
        # Embedding → user_embedding_configs
        if embedding_key:
            existing = await self._emb_repo.list_by_uid(uid, db)
            if existing:
                await self._emb_repo.update(
                    uid=uid, config_id=existing[0].id, db=db,
                    api_key_encrypted=self._encrypt(embedding_key),
                    base_url=embedding_base_url, model=embedding_model,
                )
            else:
                await self._emb_repo.create(
                    uid=uid, name="默认 Embedding", provider="openai",
                    api_key_encrypted=self._encrypt(embedding_key),
                    base_url=embedding_base_url, model=embedding_model,
                    is_default=True, db=db,
                )
        # ASR → user_asr_configs
        if asr_key:
            existing = await self._asr_repo.list_by_uid(uid, db)
            if existing:
                await self._asr_repo.update(
                    uid=uid, config_id=existing[0].id, db=db,
                    api_key_encrypted=self._encrypt(asr_key),
                    base_url=asr_base_url, model=asr_model,
                )
            else:
                await self._asr_repo.create(
                    uid=uid, name="默认 ASR", provider="dashscope",
                    api_key_encrypted=self._encrypt(asr_key),
                    base_url=asr_base_url, model=asr_model,
                    is_default=True, db=db,
                )
        logger.info(f"[API_KEY_MANAGER] settings updated for uid={uid}")

    async def delete_credentials(self, uid: int, db: AsyncSession) -> None:
        """兼容旧 settings 删除 — 软删除 embed + asr 配置"""
        emb_configs = await self._emb_repo.list_by_uid(uid, db)
        for c in emb_configs:
            await self._emb_repo.delete(uid, c.id, db)
        asr_configs = await self._asr_repo.list_by_uid(uid, db)
        for c in asr_configs:
            await self._asr_repo.delete(uid, c.id, db)
        logger.info(f"[API_KEY_MANAGER] settings deleted for uid={uid}")

    async def get_status(self, uid: int, db: AsyncSession) -> dict:
        """获取用户 Embedding / ASR 配置状态"""
        emb_default = await self._emb_repo.get_default(uid, db)
        asr_default = await self._asr_repo.get_default(uid, db)

        return {
            "llm_is_configured": False,
            "llm_masked_key": None, "llm_base_url": None, "llm_model": None,
            "embedding_is_configured": emb_default is not None,
            "embedding_masked_key": (
                self._mask_key(self._decrypt(emb_default.api_key_encrypted))
                if emb_default else None
            ),
            "embedding_base_url": emb_default.base_url if emb_default else None,
            "embedding_model": emb_default.model if emb_default else None,
            "asr_is_configured": asr_default is not None,
            "asr_masked_key": (
                self._mask_key(self._decrypt(asr_default.api_key_encrypted))
                if asr_default else None
            ),
            "asr_base_url": asr_default.base_url if asr_default else None,
            "asr_model": asr_default.model if asr_default else None,
            "updated_at": (
                max(
                    emb_default.updated_at if emb_default else datetime.min,
                    asr_default.updated_at if asr_default else datetime.min,
                )
                if (emb_default or asr_default) else None
            ),
        }

    async def get_embedding_credentials(
        self, uid: Optional[int], db: AsyncSession
    ) -> Optional[UserCredentials]:
        """获取用户默认 Embedding 配置"""
        return await self.get_default_embedding_credentials(uid, db)

    def get_llm_key_sync(self, uid: Optional[int]) -> Optional[UserCredentials]:
        """[deprecated] 同步获取 LLM Key — 等同于 get_default_credential_sync"""
        return self.get_default_credential_sync(uid)

    # ═══════════════════════════════════════════════════════════
    # 内部方法
    # ═══════════════════════════════════════════════════════════

    def _cache_key(self, uid: int) -> str:
        return f"cred:{uid}"

    async def _get_cache_entry(
        self, uid: int, db: AsyncSession
    ) -> Optional[CacheEntry]:
        """获取缓存条目（缓存未命中则查库并写入缓存）"""
        cache_key = self._cache_key(uid)
        entry = self._normalize_entry(await self._cache.get(cache_key))
        if entry is not None:
            return entry

        records = await self._cred_repo.list_by_uid(uid, db)
        if not records:
            empty_dict = {"credentials": {}, "default_credential_id": None, "expire_at": time.time() + self.CACHE_TTL}
            await self._cache.set(cache_key, empty_dict, self.CACHE_TTL)
            return None

        entry = CacheEntry(
            credentials={
                r.id: CredentialCacheData(
                    api_key_encrypted=r.api_key_encrypted,
                    base_url=r.base_url,
                    default_model=r.default_model,
                    provider=r.provider,
                )
                for r in records
            },
            default_credential_id=next(
                (r.id for r in records if r.is_default),
                records[0].id if records else None,
            ),
            expire_at=time.time() + self.CACHE_TTL,
        )
        await self._cache.set(cache_key, entry, self.CACHE_TTL)
        return entry

    async def _refresh_cache(self, uid: int, db: AsyncSession) -> None:
        """强制刷新缓存"""
        cache_key = self._cache_key(uid)
        await self._cache.delete(cache_key)
        records = await self._cred_repo.list_by_uid(uid, db)
        if records:
            entry = CacheEntry(
                credentials={
                    r.id: CredentialCacheData(
                        api_key_encrypted=r.api_key_encrypted,
                        base_url=r.base_url,
                        default_model=r.default_model,
                        provider=r.provider,
                    )
                    for r in records
                },
                default_credential_id=next(
                    (r.id for r in records if r.is_default), None
                ),
                expire_at=time.time() + self.CACHE_TTL,
            )
            # Serialize dataclass to dict for JSON-safe caching
            entry_dict = {
                "credentials": {
                    str(cid): {
                        "api_key_encrypted": cd.api_key_encrypted,
                        "base_url": cd.base_url,
                        "default_model": cd.default_model,
                        "provider": cd.provider,
                    }
                    for cid, cd in entry.credentials.items()
                },
                "default_credential_id": entry.default_credential_id,
                "expire_at": entry.expire_at,
            }
            await self._cache.set(cache_key, entry_dict, self.CACHE_TTL)

    @staticmethod
    def _normalize_entry(raw: object) -> Optional[CacheEntry]:
        """Accept either a CacheEntry or a plain dict (from JSON cache backend)."""
        if raw is None:
            return None
        if isinstance(raw, CacheEntry):
            return raw
        if isinstance(raw, dict):
            return CacheEntry(
                credentials={
                    int(k): CredentialCacheData(**v)
                    for k, v in raw.get("credentials", {}).items()
                },
                default_credential_id=raw.get("default_credential_id"),
                expire_at=raw.get("expire_at", 0.0),
            )
        return None

    def _encrypt(self, plaintext: str) -> str:
        """AES-256-GCM 加密 → base64(nonce + ciphertext)。若无密钥则明文 base64。"""
        if self._aesgcm is None:
            return base64.b64encode(plaintext.encode()).decode()
        nonce = os.urandom(12)
        ciphertext = self._aesgcm.encrypt(nonce, plaintext.encode(), None)
        return base64.b64encode(nonce + ciphertext).decode()

    def _decrypt(self, ciphertext_b64: str) -> str:
        """base64 → 解密。若无密钥则直接 base64 解码返回明文。"""
        raw = base64.b64decode(ciphertext_b64)
        if self._aesgcm is None:
            return raw.decode()
        nonce, ciphertext = raw[:12], raw[12:]
        return self._aesgcm.decrypt(nonce, ciphertext, None).decode()

    def _mask_key(self, api_key: str) -> str:
        """隐藏 Key 中间部分，如 'sk-abc...4f2a'"""
        if len(api_key) <= 11:
            return api_key[:3] + "***" + api_key[-3:]
        return api_key[:6] + "***" + api_key[-4:]

    @property
    def is_enabled(self) -> bool:
        return self._enabled
