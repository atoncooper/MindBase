"""
EmbeddingConfigRepository — user_embedding_configs 表的 CRUD 操作
"""
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models import UserEmbeddingConfig

_ALIVE = UserEmbeddingConfig.deleted_at == None  # noqa: E711


class EmbeddingConfigRepository:

    async def list_by_uid(
        self, uid: int, db: AsyncSession
    ) -> list[UserEmbeddingConfig]:
        result = await db.execute(
            select(UserEmbeddingConfig)
            .where(UserEmbeddingConfig.uid == uid, _ALIVE)
            .order_by(UserEmbeddingConfig.updated_at.desc())
        )
        return list(result.scalars().all())

    async def get_by_id(
        self, config_id: int, db: AsyncSession
    ) -> Optional[UserEmbeddingConfig]:
        result = await db.execute(
            select(UserEmbeddingConfig).where(UserEmbeddingConfig.id == config_id)
        )
        return result.scalar_one_or_none()

    async def create(
        self, uid: int, name: str, provider: str, api_key_encrypted: str,
        base_url: Optional[str], model: Optional[str], is_default: bool,
        db: AsyncSession,
    ) -> UserEmbeddingConfig:
        if is_default:
            await self._clear_default(uid, db)
        record = UserEmbeddingConfig(
            uid=uid, name=name, provider=provider,
            api_key_encrypted=api_key_encrypted, base_url=base_url,
            model=model, is_default=is_default,
        )
        db.add(record)
        await db.commit()
        await db.refresh(record)
        logger.info(f"[EMB_REPO] created id={record.id} uid={uid}")
        return record

    async def update(
        self, uid: int, config_id: int, db: AsyncSession,
        name: Optional[str] = None, api_key_encrypted: Optional[str] = None,
        base_url: Optional[str] = None, model: Optional[str] = None,
        is_default: Optional[bool] = None,
    ) -> Optional[UserEmbeddingConfig]:
        record = await self.get_by_id(config_id, db)
        if record is None or record.uid != uid or record.deleted_at is not None:
            return None
        if name is not None:
            record.name = name
        if api_key_encrypted is not None:
            record.api_key_encrypted = api_key_encrypted
        if base_url is not None:
            record.base_url = base_url
        if model is not None:
            record.model = model
        if is_default:
            await self._clear_default(uid, db, exclude_id=config_id)
            record.is_default = True
        await db.commit()
        await db.refresh(record)
        logger.info(f"[EMB_REPO] updated id={config_id}")
        return record

    async def delete(self, uid: int, config_id: int, db: AsyncSession) -> bool:
        record = await self.get_by_id(config_id, db)
        if record is None or record.uid != uid or record.deleted_at is not None:
            return False
        record.deleted_at = datetime.now(timezone.utc)
        await db.commit()
        logger.info(f"[EMB_REPO] soft-deleted id={config_id}")
        return True

    async def set_default(
        self, uid: int, config_id: int, db: AsyncSession
    ) -> bool:
        record = await self.get_by_id(config_id, db)
        if record is None or record.uid != uid or record.deleted_at is not None:
            return False
        await self._clear_default(uid, db, exclude_id=config_id)
        record.is_default = True
        await db.commit()
        await db.refresh(record)
        return True

    async def get_default(
        self, uid: int, db: AsyncSession
    ) -> Optional[UserEmbeddingConfig]:
        result = await db.execute(
            select(UserEmbeddingConfig).where(
                UserEmbeddingConfig.uid == uid,
                UserEmbeddingConfig.is_default == True,  # noqa: E712
                _ALIVE,
            )
        )
        return result.scalar_one_or_none()

    async def _clear_default(
        self, uid: int, db: AsyncSession, exclude_id: Optional[int] = None,
    ) -> None:
        stmt = (
            update(UserEmbeddingConfig)
            .where(UserEmbeddingConfig.uid == uid, UserEmbeddingConfig.is_default == True, _ALIVE)  # noqa: E712
            .values(is_default=False)
        )
        if exclude_id is not None:
            stmt = stmt.where(UserEmbeddingConfig.id != exclude_id)
        await db.execute(stmt)

    async def update_test_result(self, config_id: int, db: AsyncSession,
                                 status: str, error: Optional[str]) -> bool:
        record = await self.get_by_id(config_id, db)
        if record is None:
            return False
        record.last_test_status = status
        record.last_test_error = error
        record.last_test_at = datetime.now(timezone.utc)
        await db.commit()
        return True


_emb_repo: Optional[EmbeddingConfigRepository] = None


def get_embedding_config_repository() -> EmbeddingConfigRepository:
    global _emb_repo
    if _emb_repo is None:
        _emb_repo = EmbeddingConfigRepository()
    return _emb_repo
