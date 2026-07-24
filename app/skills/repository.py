"""SkillRepository - MySQL CRUD for installed_skills rows (per-user).

The skill *content* lives in MinIO; this table is only the per-user index
(uid + skill_id / name / description / minio_key / manifest) that each
user's agent sees in its system prompt and that ``SkillManager.load_skill``
uses to locate the zip in MinIO.
"""

from __future__ import annotations

import logging

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import InstalledSkill

logger = logging.getLogger(__name__)


class SkillRepository:
    """Per-user CRUD access to ``installed_skills``."""

    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def list_all(self, uid: int, *, enabled_only: bool = True) -> list[InstalledSkill]:
        stmt = select(InstalledSkill).where(InstalledSkill.uid == uid)
        if enabled_only:
            stmt = stmt.where(InstalledSkill.enabled.is_(True))
        stmt = stmt.order_by(InstalledSkill.name)
        result = await self._db.execute(stmt)
        return list(result.scalars())

    async def get(self, uid: int, skill_id: str) -> InstalledSkill | None:
        result = await self._db.execute(
            select(InstalledSkill).where(
                InstalledSkill.uid == uid,
                InstalledSkill.skill_id == skill_id,
            )
        )
        return result.scalar_one_or_none()

    async def upsert(
        self,
        *,
        uid: int,
        skill_id: str,
        name: str,
        description: str | None,
        version: str | None,
        source_store: str | None,
        minio_key: str,
        manifest: dict | None,
    ) -> InstalledSkill:
        existing = await self.get(uid, skill_id)
        if existing is not None:
            existing.name = name
            existing.description = description
            existing.version = version
            existing.source_store = source_store
            existing.minio_key = minio_key
            existing.manifest = manifest
            await self._db.flush()
            return existing
        row = InstalledSkill(
            uid=uid,
            skill_id=skill_id,
            name=name,
            description=description,
            version=version,
            source_store=source_store,
            minio_key=minio_key,
            manifest=manifest,
        )
        self._db.add(row)
        await self._db.flush()
        return row

    async def delete(self, uid: int, skill_id: str) -> bool:
        result = await self._db.execute(
            delete(InstalledSkill).where(
                InstalledSkill.uid == uid,
                InstalledSkill.skill_id == skill_id,
            )
        )
        return (result.rowcount or 0) > 0
