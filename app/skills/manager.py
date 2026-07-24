"""SkillManager - per-user lazy load of Skills from MinIO (never local disk).

Each user manages their own installed skills. The skill *content* (zip)
lives in MinIO at ``skills/{uid}/{skill_id}.zip``; the per-user index lives
in the ``installed_skills`` MySQL table. When an agent calls
``load_skill(name)``, the manager fetches the zip from MinIO, parses it in
memory, caches it (LRU, per uid+skill_id), and returns the instructions.

Skill code tools (``manifest.has_code_tools``) are **not executed** yet -
sandbox support is pending.
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from typing import Any, Optional

from app.skills.repository import SkillRepository
from app.skills.zip_parser import Skill, inspect_zip, parse_skill_zip

logger = logging.getLogger(__name__)


class SkillManager:
    """Per-user lazy load of installed skills from MinIO.

    Usage::

        mgr = SkillManager(session_factory)
        idx = await mgr.index_text(uid)              # inject into prompt
        skill = await mgr.load_skill(uid, "video-summary")
        await mgr.install(uid=1, skill_id=..., zip_bytes=..., ...)
    """

    def __init__(
        self,
        session_factory: Any = None,
        minio_client: Any = None,
        *,
        cache_max: int = 32,
    ) -> None:
        self._session_factory = session_factory
        self._minio = minio_client  # lazy via _get_minio() if None
        self._cache: "OrderedDict[tuple[int, str], Skill]" = OrderedDict()
        self._cache_max = cache_max

    # ── minio access ───────────────────────────────────────────────────

    def _get_minio(self) -> Any:
        if self._minio is None:
            from app.infra.minio import get_minio_client

            self._minio = get_minio_client()
        return self._minio

    # ── index (for system prompt) ──────────────────────────────────────

    async def list_installed(self, uid: int) -> list[Any]:
        """Return a user's installed_skills rows (enabled only)."""
        if self._session_factory is None:
            return []
        async with self._session_factory() as db:
            return await SkillRepository(db).list_all(uid)

    async def index_text(self, uid: int) -> str:
        """Compact skill index for the user's system prompt (async - reads MySQL)."""
        skills = await self.list_installed(uid)
        if not skills:
            return ""
        lines = [
            "## 可用技能（Skills）",
            "当用户任务匹配某技能时，调用 load_skill(name) 加载详细指令：",
        ]
        for s in skills:
            desc = s.description or s.name
            lines.append(f"- {s.skill_id}: {desc}")
        return "\n".join(lines)

    # ── lazy load from MinIO ───────────────────────────────────────────

    async def load_skill(self, uid: int, skill_id: str) -> Optional[Skill]:
        """Fetch the user's skill zip from MinIO, parse in memory, cache, return."""
        cache_key = (uid, skill_id)
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached

        if self._session_factory is None:
            return None
        async with self._session_factory() as db:
            meta = await SkillRepository(db).get(uid, skill_id)
        if meta is None:
            return None

        try:
            zip_bytes = await self._get_minio().get_object(meta.minio_key)
        except Exception:
            logger.exception(
                "[SKILLS] minio get failed uid=%s skill=%s key=%s", uid, skill_id, meta.minio_key
            )
            return None

        skill = parse_skill_zip(
            zip_bytes,
            skill_id=meta.skill_id,
            name=meta.name,
            description=meta.description or "",
        )
        self._cache_put(cache_key, skill)
        return skill

    async def preview_skill(self, uid: int, skill_id: str) -> Optional[dict]:
        """Inspect an installed skill's zip from MinIO for the preview UI.

        Returns ``None`` if the skill is not installed or MinIO is unreachable.
        """
        if self._session_factory is None:
            return None
        async with self._session_factory() as db:
            meta = await SkillRepository(db).get(uid, skill_id)
        if meta is None:
            return None
        try:
            zip_bytes = await self._get_minio().get_object(meta.minio_key)
        except Exception:
            logger.exception(
                "[SKILLS] minio get (preview) failed uid=%s skill=%s", uid, skill_id
            )
            return None
        info = inspect_zip(zip_bytes)
        manifest = info["manifest"] or {}
        return {
            "skill_id": meta.skill_id,
            "name": meta.name,
            "description": meta.description,
            "version": meta.version,
            "has_code_tools": bool(manifest.get("has_code_tools", False)),
            "body": info["body"],
            "manifest": manifest,
            "files": info["files"],
        }

    # ── install / uninstall ────────────────────────────────────────────

    async def install(
        self,
        *,
        uid: int,
        skill_id: str,
        name: str,
        description: str | None,
        version: str | None,
        source_store: str | None,
        zip_bytes: bytes,
        manifest: dict | None,
    ) -> None:
        """Upload the zip to MinIO (per-user key) and write the installed_skills row."""
        minio_key = f"skills/{uid}/{skill_id}.zip"
        await self._get_minio().put_object(minio_key, zip_bytes, "application/zip")
        async with self._session_factory() as db:
            await SkillRepository(db).upsert(
                uid=uid,
                skill_id=skill_id,
                name=name,
                description=description,
                version=version,
                source_store=source_store,
                minio_key=minio_key,
                manifest=manifest,
            )
            await db.commit()
        self._cache.pop((uid, skill_id), None)
        logger.info("[SKILLS] installed uid=%s skill=%s", uid, skill_id)

    async def uninstall(self, uid: int, skill_id: str) -> bool:
        """Delete the user's zip from MinIO and the row from MySQL."""
        if self._session_factory is None:
            return False
        async with self._session_factory() as db:
            meta = await SkillRepository(db).get(uid, skill_id)
        if meta is None:
            return False
        try:
            await self._get_minio().delete_object(meta.minio_key)
        except Exception:
            logger.exception("[SKILLS] minio delete failed uid=%s skill=%s", uid, skill_id)
        async with self._session_factory() as db:
            await SkillRepository(db).delete(uid, skill_id)
            await db.commit()
        self._cache.pop((uid, skill_id), None)
        logger.info("[SKILLS] uninstalled uid=%s skill=%s", uid, skill_id)
        return True

    # ── cache ──────────────────────────────────────────────────────────

    def _cache_put(self, key: tuple[int, str], skill: Skill) -> None:
        self._cache[key] = skill
        self._cache.move_to_end(key)
        while len(self._cache) > self._cache_max:
            self._cache.popitem(last=False)

    def invalidate(self, uid: int | None = None, skill_id: str | None = None) -> None:
        """Drop cached skills (one user's, one skill, or all)."""
        if uid is None and skill_id is None:
            self._cache.clear()
        elif uid is not None and skill_id is not None:
            self._cache.pop((uid, skill_id), None)
        elif uid is not None:
            for k in [k for k in self._cache if k[0] == uid]:
                self._cache.pop(k, None)
