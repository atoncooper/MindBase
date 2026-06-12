"""
UserDeviceRepository — user_device table CRUD.
"""

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models import UserDevice


class UserDeviceRepository:
    """Data access for the user_device table."""

    async def upsert(
        self,
        db: AsyncSession,
        *,
        uid: int,
        device_id: str,
        device_type: Optional[str] = None,
        device_name: Optional[str] = None,
        os: Optional[str] = None,
        os_version: Optional[str] = None,
        browser: Optional[str] = None,
        browser_version: Optional[str] = None,
        fingerprint: Optional[str] = None,
        commit: bool = True,
    ) -> UserDevice:
        now = datetime.now(timezone.utc)
        result = await db.execute(
            select(UserDevice).where(UserDevice.device_id == device_id)
        )
        existing = result.scalar_one_or_none()

        if existing and existing.uid != uid:
            logger.warning(
                "[DEVICE_REPO] device_id collision ignored device_id={} uid={} owner_uid={}",
                device_id,
                uid,
                existing.uid,
            )
            return existing

        if existing:
            existing.device_type = device_type or existing.device_type
            existing.device_name = device_name or existing.device_name
            existing.os = os or existing.os
            existing.os_version = os_version or existing.os_version
            existing.browser = browser or existing.browser
            existing.browser_version = browser_version or existing.browser_version
            existing.fingerprint = fingerprint or existing.fingerprint
            existing.last_active_at = now
            existing.deleted_at = None
            if commit:
                await db.commit()
                await db.refresh(existing)
            else:
                await db.flush()
            logger.info(f"[DEVICE_REPO] updated device_id={device_id} uid={uid}")
            return existing

        device = UserDevice(
            device_id=device_id,
            uid=uid,
            device_type=device_type,
            device_name=device_name,
            os=os,
            os_version=os_version,
            browser=browser,
            browser_version=browser_version,
            fingerprint=fingerprint,
            last_active_at=now,
        )
        db.add(device)
        if commit:
            await db.commit()
            await db.refresh(device)
        else:
            await db.flush()
        logger.info(f"[DEVICE_REPO] created device_id={device_id} uid={uid}")
        return device

    async def list_by_uid(self, uid: int, db: AsyncSession) -> list[UserDevice]:
        result = await db.execute(
            select(UserDevice)
            .where(
                UserDevice.uid == uid,
                UserDevice.deleted_at.is_(None),
            )
            .order_by(UserDevice.last_active_at.desc())
        )
        return list(result.scalars().all())


_device_repo: Optional[UserDeviceRepository] = None


def get_user_device_repository() -> UserDeviceRepository:
    global _device_repo
    if _device_repo is None:
        _device_repo = UserDeviceRepository()
    return _device_repo
