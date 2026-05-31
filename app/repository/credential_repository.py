"""
CredentialRepository — user_credentials 表的数据库 CRUD 操作

职责：封装对 user_credentials 表的所有数据库访问。
注意：不包含加密/解密逻辑（由 services/llm/api_key_manager.py 负责）。
软删除：delete 设置 deleted_at，所有查询过滤 deleted_at IS NULL。
"""
from datetime import datetime
from typing import Optional
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models import UserCredential

_ALIVE = UserCredential.deleted_at == None  # noqa: E711


class CredentialRepository:
    """user_credentials 表的数据访问层"""

    async def list_by_uid(
        self, uid: int, db: AsyncSession
    ) -> list[UserCredential]:
        """列出用户全部未删除 credential（按 updated_at 倒序）"""
        result = await db.execute(
            select(UserCredential)
            .where(UserCredential.uid == uid, _ALIVE)
            .order_by(UserCredential.updated_at.desc())
        )
        return list(result.scalars().all())

    async def get_by_id(
        self, credential_id: int, db: AsyncSession
    ) -> Optional[UserCredential]:
        """根据 ID 查询单个 credential（含已删除，供内部使用）"""
        result = await db.execute(
            select(UserCredential).where(UserCredential.id == credential_id)
        )
        return result.scalar_one_or_none()

    async def create(
        self,
        uid: int,
        name: str,
        provider: str,
        api_key_encrypted: str,
        base_url: Optional[str],
        default_model: Optional[str],
        is_default: bool,
        db: AsyncSession,
    ) -> UserCredential:
        """新建 credential。若 is_default=True，先清除同 uid 其他默认。"""
        if is_default:
            await self._clear_default(uid, db)

        record = UserCredential(
            uid=uid,
            name=name,
            provider=provider,
            api_key_encrypted=api_key_encrypted,
            base_url=base_url,
            default_model=default_model,
            is_default=is_default,
        )
        db.add(record)
        await db.commit()
        await db.refresh(record)
        logger.info(
            f"[CRED_REPO] created id={record.id} provider={provider} uid={uid}"
        )
        return record

    async def update(
        self,
        uid: int,
        credential_id: int,
        db: AsyncSession,
        name: Optional[str] = None,
        api_key_encrypted: Optional[str] = None,
        base_url: Optional[str] = None,
        default_model: Optional[str] = None,
        is_default: Optional[bool] = None,
    ) -> Optional[UserCredential]:
        """部分更新 credential。返回更新后的记录，不存在/不属于该用户/已删除返回 None。"""
        record = await self.get_by_id(credential_id, db)
        if record is None or record.uid != uid or record.deleted_at is not None:
            return None

        if name is not None:
            record.name = name
        if api_key_encrypted is not None:
            record.api_key_encrypted = api_key_encrypted
        if base_url is not None:
            record.base_url = base_url
        if default_model is not None:
            record.default_model = default_model
        if is_default:
            await self._clear_default(record.uid, db, exclude_id=credential_id)
            record.is_default = True

        await db.commit()
        await db.refresh(record)
        logger.info(f"[CRED_REPO] updated id={credential_id}")
        return record

    async def delete(self, uid: int, credential_id: int, db: AsyncSession) -> bool:
        """软删除 credential。返回 True 表示成功，False 表示不存在/不属于该用户/已删除。"""
        record = await self.get_by_id(credential_id, db)
        if record is None or record.uid != uid or record.deleted_at is not None:
            return False
        record.deleted_at = datetime.utcnow()
        await db.commit()
        logger.info(f"[CRED_REPO] soft-deleted id={credential_id}")
        return True

    async def set_default(
        self, uid: int, credential_id: int, db: AsyncSession
    ) -> bool:
        """将指定 credential 设为默认（原子操作：先清默认，再设这个）。"""
        record = await self.get_by_id(credential_id, db)
        if record is None or record.uid != uid or record.deleted_at is not None:
            return False

        await self._clear_default(uid, db, exclude_id=credential_id)
        record.is_default = True
        await db.commit()
        await db.refresh(record)
        logger.info(f"[CRED_REPO] set_default id={credential_id} uid={uid}")
        return True

    async def get_default(
        self, uid: int, db: AsyncSession
    ) -> Optional[UserCredential]:
        """获取用户未删除的默认 credential"""
        result = await db.execute(
            select(UserCredential).where(
                UserCredential.uid == uid,
                UserCredential.is_default == True,  # noqa: E712
                _ALIVE,
            )
        )
        return result.scalar_one_or_none()

    async def _clear_default(
        self,
        uid: int,
        db: AsyncSession,
        exclude_id: Optional[int] = None,
    ) -> None:
        """清除该 uid 下所有未删除 credential 的 is_default 标志"""
        stmt = (
            update(UserCredential)
            .where(
                UserCredential.uid == uid,
                UserCredential.is_default == True,  # noqa: E712
                _ALIVE,
            )
            .values(is_default=False)
        )
        if exclude_id is not None:
            stmt = stmt.where(UserCredential.id != exclude_id)
        await db.execute(stmt)

    async def update_test_result(self, credential_id: int, db: AsyncSession,
                                 status: str, error: Optional[str]) -> bool:
        record = await self.get_by_id(credential_id, db)
        if record is None:
            return False
        record.last_test_status = status
        record.last_test_error = error
        record.last_test_at = datetime.utcnow()
        await db.commit()
        return True


# 模块级单例
_credential_repo: Optional[CredentialRepository] = None


def get_credential_repository() -> CredentialRepository:
    """获取 CredentialRepository 单例"""
    global _credential_repo
    if _credential_repo is None:
        _credential_repo = CredentialRepository()
    return _credential_repo
