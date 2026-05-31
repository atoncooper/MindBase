"""
RbacRepository — rbac_role and rbac_user_role tables.

Idempotent seed data for system roles is also handled here.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models import RbacRole, RbacUserRole

DEFAULT_ROLE = "free"


class RbacRepository:
    """Data access for RBAC tables."""

    # ── role ─────────────────────────────────────────────────────

    async def get_role(self, role_id: str, db: AsyncSession) -> Optional[RbacRole]:
        return await db.get(RbacRole, role_id)

    async def seed_role(self, role_id: str, name: str, description: str, db: AsyncSession) -> None:
        """Insert a role if it does not already exist (idempotent)."""
        if await self.get_role(role_id, db):
            return
        db.add(RbacRole(role_id=role_id, name=name, description=description, is_system=True))
        await db.commit()
        logger.info(f"[RBAC_REPO] seeded role: {role_id}")

    async def seed_defaults(self, db: AsyncSession) -> None:
        """Seed all system roles."""
        await self.seed_role("free", "免费用户", "Default role — basic Q&A and knowledge base", db)
        await self.seed_role("admin", "管理员", "System admin — full access", db)

    # ── user-role association ────────────────────────────────────

    async def get_user_roles(self, uid: int, db: AsyncSession) -> list[str]:
        """Return the list of active role_id strings for a user."""
        result = await db.execute(
            select(RbacUserRole.role_id).where(
                RbacUserRole.uid == uid,
                RbacUserRole.is_active == True,  # noqa: E712
            )
        )
        return [row[0] for row in result.fetchall()]

    async def grant_role(self, uid: int, role_id: str, db: AsyncSession,
                         granted_by: int = 0) -> RbacUserRole:
        record = RbacUserRole(
            uid=uid, role_id=role_id,
            granted_by=granted_by, granted_at=datetime.utcnow(),
            is_active=True,
        )
        db.add(record)
        await db.commit()
        logger.info(f"[RBAC_REPO] granted {role_id} to uid={uid}")
        return record


_rbac_repo: Optional[RbacRepository] = None


def get_rbac_repository() -> RbacRepository:
    global _rbac_repo
    if _rbac_repo is None:
        _rbac_repo = RbacRepository()
    return _rbac_repo
