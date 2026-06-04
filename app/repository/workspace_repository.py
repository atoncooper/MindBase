"""Plan 0023: Workspace repository — CRUD + binding expansion."""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import select, func, text, delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Workspace, WorkspaceBinding, CloudFile

logger = logging.getLogger(__name__)

CACHE_TTL = 60
CACHE_KEY_PREFIX = "ws:expand:"


class WorkspaceRepository:
    """Workspace CRUD and binding expansion."""

    def __init__(self, redis=None):
        self._redis = redis

    # ── CRUD ──────────────────────────────────────────────────────

    async def list_by_uid(self, uid: int, db: AsyncSession) -> list[Workspace]:
        stmt = (
            select(Workspace)
            .where(Workspace.uid == uid, Workspace.deleted_at.is_(None))
            .order_by(Workspace.updated_at.desc())
        )
        result = await db.execute(stmt)
        return list(result.scalars().all())

    async def get_by_id(self, workspace_id: int, uid: int, db: AsyncSession) -> Optional[Workspace]:
        stmt = select(Workspace).where(
            Workspace.id == workspace_id,
            Workspace.uid == uid,
            Workspace.deleted_at.is_(None),
        )
        result = await db.execute(stmt)
        return result.scalar_one_or_none()

    async def create(
        self, uid: int, name: str, db: AsyncSession,
        description: Optional[str] = None,
        icon: Optional[str] = None,
        color: Optional[str] = None,
    ) -> Workspace:
        ws = Workspace(
            uid=uid,
            name=name,
            description=description,
            icon=icon,
            color=color,
        )
        db.add(ws)
        await db.commit()
        await db.refresh(ws)
        return ws

    async def update(
        self, workspace_id: int, uid: int, db: AsyncSession, **kwargs,
    ) -> Optional[Workspace]:
        ws = await self.get_by_id(workspace_id, uid, db)
        if ws is None:
            return None
        for key, value in kwargs.items():
            if value is not None and hasattr(ws, key):
                setattr(ws, key, value)
        ws.updated_at = datetime.utcnow()
        await db.commit()
        await db.refresh(ws)
        return ws

    async def soft_delete(self, workspace_id: int, uid: int, db: AsyncSession) -> bool:
        ws = await self.get_by_id(workspace_id, uid, db)
        if ws is None:
            return False
        ws.deleted_at = datetime.utcnow()
        # Cascade-delete bindings via FK ON DELETE CASCADE
        await db.execute(
            sa_delete(WorkspaceBinding).where(WorkspaceBinding.workspace_id == workspace_id)
        )
        await db.commit()
        # Invalidate cache
        await self._invalidate_cache(workspace_id, uid)
        return True

    # ── Bindings ──────────────────────────────────────────────────

    async def get_bindings(self, workspace_id: int, uid: int, db: AsyncSession) -> list[WorkspaceBinding]:
        stmt = select(WorkspaceBinding).where(
            WorkspaceBinding.workspace_id == workspace_id,
            WorkspaceBinding.uid == uid,
        )
        result = await db.execute(stmt)
        return list(result.scalars().all())

    async def add_binding(
        self, workspace_id: int, uid: int, db: AsyncSession,
        bind_type: str,
        folder_id: Optional[int] = None,
        upload_uuid: Optional[str] = None,
        include_subfolders: bool = True,
    ) -> WorkspaceBinding:
        binding = WorkspaceBinding(
            workspace_id=workspace_id,
            uid=uid,
            bind_type=bind_type,
            folder_id=folder_id,
            upload_uuid=upload_uuid,
            include_subfolders=include_subfolders,
        )
        db.add(binding)
        await db.commit()
        await db.refresh(binding)

        # Recount workspace stats
        await self._recalc_workspace_stats(workspace_id, uid, db)

        # Invalidate cache
        await self._invalidate_cache(workspace_id, uid)
        return binding

    async def remove_binding(self, binding_id: int, workspace_id: int, uid: int, db: AsyncSession) -> bool:
        stmt = sa_delete(WorkspaceBinding).where(
            WorkspaceBinding.id == binding_id,
            WorkspaceBinding.workspace_id == workspace_id,
            WorkspaceBinding.uid == uid,
        )
        result = await db.execute(stmt)
        await db.commit()

        if result.rowcount > 0:
            await self._recalc_workspace_stats(workspace_id, uid, db)
            await self._invalidate_cache(workspace_id, uid)
            return True
        return False

    # ── Expansion (core retrieval method) ─────────────────────────

    async def expand_bindings(self, workspace_id: int, uid: int, db: AsyncSession) -> set[str]:
        """Expand workspace bindings into a set of upload_uuids (vectorizable only).

        Cached in Redis (TTL 60s) to avoid repeated DB queries during retrieval.
        """
        # Try cache first
        if self._redis:
            cache_key = f"{CACHE_KEY_PREFIX}{workspace_id}:{uid}"
            try:
                cached = await self._redis.get(cache_key)
                if cached is not None:
                    return set(json.loads(cached))
            except Exception as e:
                logger.debug("[WS] redis get failed: %s", e)

        # DB expansion
        upload_uuids = await self._expand_bindings_from_db(workspace_id, uid, db)

        # Write cache
        if self._redis:
            try:
                cache_key = f"{CACHE_KEY_PREFIX}{workspace_id}:{uid}"
                await self._redis.set(cache_key, json.dumps(list(upload_uuids)), ex=CACHE_TTL)
            except Exception as e:
                logger.debug("[WS] redis set failed: %s", e)

        return upload_uuids

    async def _expand_bindings_from_db(self, workspace_id: int, uid: int, db: AsyncSession) -> set[str]:
        bindings = await self.get_bindings(workspace_id, uid, db)

        upload_uuids: set[str] = set()
        folder_ids: set[int] = set()

        for b in bindings:
            if b.bind_type == "file":
                upload_uuids.add(b.upload_uuid)
            elif b.bind_type == "folder":
                folder_ids.add(b.folder_id)
                if b.include_subfolders:
                    sub_ids = await self._get_subfolder_ids_cte(b.folder_id, uid, db)
                    folder_ids.update(sub_ids)

        if folder_ids:
            result = await db.execute(
                select(CloudFile.upload_uuid).where(
                    CloudFile.folder_id.in_(folder_ids),
                    CloudFile.uid == uid,
                    CloudFile.vectorizable,
                    CloudFile.deleted_at.is_(None),
                )
            )
            upload_uuids.update(f for f in result.scalars().all())

        # Defensive: filter out non-vectorizable explicit file bindings
        if upload_uuids:
            result = await db.execute(
                select(CloudFile.upload_uuid).where(
                    CloudFile.upload_uuid.in_(upload_uuids),
                    CloudFile.vectorizable,
                    CloudFile.deleted_at.is_(None),
                )
            )
            upload_uuids = set(result.scalars().all())

        return upload_uuids

    async def _get_subfolder_ids_cte(self, root_folder_id: int, uid: int, db: AsyncSession) -> set[int]:
        """Get all descendant folder IDs using WITH RECURSIVE CTE."""
        result = await db.execute(
            text("""
                WITH RECURSIVE folder_tree AS (
                    SELECT id FROM cloud_folders WHERE id = :root_id AND uid = :uid AND deleted_at IS NULL
                    UNION ALL
                    SELECT cf.id FROM cloud_folders cf
                    INNER JOIN folder_tree ft ON cf.parent_id = ft.id
                    WHERE cf.uid = :uid AND cf.deleted_at IS NULL
                )
                SELECT id FROM folder_tree
            """),
            {"root_id": root_folder_id, "uid": uid},
        )
        return {row[0] for row in result.fetchall()}

    # ── Stats ─────────────────────────────────────────────────────

    async def _recalc_workspace_stats(self, workspace_id: int, uid: int, db: AsyncSession):
        upload_uuids = await self._expand_bindings_from_db(workspace_id, uid, db)
        file_count = len(upload_uuids)
        chunk_count = 0
        if upload_uuids:
            result = await db.execute(
                select(func.sum(CloudFile.vector_chunk_count)).where(
                    CloudFile.upload_uuid.in_(upload_uuids),
                )
            )
            chunk_count = result.scalar() or 0

        ws = await self.get_by_id(workspace_id, uid, db)
        if ws:
            ws.file_count = file_count
            ws.chunk_count = chunk_count
            await db.commit()

    async def get_files_in_workspace(self, workspace_id: int, uid: int, db: AsyncSession):
        """List all files within a workspace scope (for UI binding selector)."""
        upload_uuids = await self._expand_bindings_from_db(workspace_id, uid, db)
        if not upload_uuids:
            return []
        result = await db.execute(
            select(CloudFile).where(
                CloudFile.upload_uuid.in_(upload_uuids),
                CloudFile.uid == uid,
                CloudFile.deleted_at.is_(None),
            ).order_by(CloudFile.created_at.desc())
        )
        return list(result.scalars().all())

    # ── Cache helpers ─────────────────────────────────────────────

    async def _invalidate_cache(self, workspace_id: int, uid: int):
        if self._redis:
            try:
                cache_key = f"{CACHE_KEY_PREFIX}{workspace_id}:{uid}"
                await self._redis.delete(cache_key)
            except Exception as e:
                logger.debug("[WS] redis delete failed: %s", e)
