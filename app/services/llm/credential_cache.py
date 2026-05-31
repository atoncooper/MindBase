"""
Credential cache — thin adapter over the unified cache infrastructure.

Before: self-contained LocalMemoryCache / CredentialCacheBackend ABC
After:  delegates to cache_manager.namespace("credential", ttl=300)
"""

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional

from app.infra.cache import cache_manager

CREDENTIAL_TTL = 300   # 5 minutes


@dataclass
class CredentialCacheData:
    """单个 credential 的缓存数据（只存密文）"""
    api_key_encrypted: str
    base_url: Optional[str] = None
    default_model: Optional[str] = None
    provider: str = ""


@dataclass
class CacheEntry:
    """多 credential 缓存条目"""
    credentials: dict[int, CredentialCacheData] = field(default_factory=dict)
    default_credential_id: Optional[int] = None
    expire_at: float = 0.0


class CredentialCacheBackend(ABC):
    """保留抽象接口（兼容性），实现委托给 cache_manager.namespace("credential")"""

    @abstractmethod
    async def get(self, key: str) -> Optional[CacheEntry]: ...
    @abstractmethod
    async def set(self, key: str, entry: CacheEntry, ttl: int) -> None: ...
    @abstractmethod
    async def delete(self, key: str) -> None: ...
    @abstractmethod
    async def clear(self) -> None: ...


class UnifiedCredentialCache(CredentialCacheBackend):
    """Credential cache backed by cache_manager (L1 + optional L2)."""

    def __init__(self):
        self._ns = cache_manager.namespace("credential", ttl=CREDENTIAL_TTL)

    @staticmethod
    def _serialize(entry: CacheEntry) -> dict:
        return {
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

    @staticmethod
    def _deserialize(raw: object) -> Optional[CacheEntry]:
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

    async def get(self, key: str) -> Optional[CacheEntry]:
        entry = self._deserialize(await self._ns.get(key))
        if entry is None:
            return None
        if entry.expire_at > time.time():
            return entry
        await self._ns.delete(key)
        return None

    async def set(self, key: str, entry: CacheEntry, ttl: int) -> None:
        expire_at = time.time() + ttl
        if isinstance(entry, CacheEntry):
            entry.expire_at = expire_at
            data = self._serialize(entry)
        else:
            # dict from _refresh_cache — mutate and use directly
            entry["expire_at"] = expire_at
            data = entry
        await self._ns.set(key, data, ttl=ttl)

    async def delete(self, key: str) -> None:
        await self._ns.delete(key)

    async def clear(self) -> None:
        await self._ns.clear()


class LocalMemoryCache(CredentialCacheBackend):
    """Compatibility alias — delegates to UnifiedCredentialCache.

    Kept for backward compat: ApiKeyManager defaults to LocalMemoryCache().
    """

    def __init__(self):
        self._backend = UnifiedCredentialCache()

    async def get(self, key: str) -> Optional[CacheEntry]:
        return await self._backend.get(key)

    async def set(self, key: str, entry: CacheEntry, ttl: int) -> None:
        await self._backend.set(key, entry, ttl)

    async def delete(self, key: str) -> None:
        await self._backend.delete(key)

    async def clear(self) -> None:
        await self._backend.clear()
