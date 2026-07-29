"""WallpaperService - upload/serve custom wallpapers via MinIO.

Custom wallpapers are stored at ``wallpapers/{uid}/{uuid7}.{ext}``; the per-user
wallpaper preference (source/key/version) lives in ``user_preferences`` under
the ``wallpaper`` key. Switching to a new custom wallpaper or to a preset
deletes the previous custom object to avoid orphan accumulation.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.infra.minio import get_minio_client, is_enabled
from app.repository.user_preference_repository import (
    get_user_preference_repository,
)

logger = logging.getLogger(__name__)

WALLPAPER_PREF_KEY = "wallpaper"
ALLOWED_MIME = {"image/png", "image/jpeg", "image/webp", "video/mp4"}
MAX_SIZE = 50 * 1024 * 1024  # 50 MB (allows short looped mp4 dynamic wallpapers)

_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4"}


def _type_for(content_type: str) -> str:
    """Map a content type to the wallpaper type stored in the preference."""
    return "video" if content_type.startswith("video/") else "image"


def _check_minio() -> None:
    if not is_enabled():
        raise RuntimeError("MinIO 未启用，壁纸功能不可用")


class WallpaperService:
    async def upload(
        self,
        uid: int,
        data: bytes,
        content_type: str,
        db: AsyncSession,
    ) -> dict[str, Any]:
        """Upload a custom wallpaper to MinIO and update the preference.

        Deletes the previous custom wallpaper object (if any) for orphan cleanup.
        """
        _check_minio()
        if not data:
            raise ValueError("空文件")
        if content_type not in ALLOWED_MIME:
            raise ValueError(f"不支持的壁纸类型: {content_type}")
        if len(data) > MAX_SIZE:
            raise ValueError("壁纸大小超过 50MB 限制")

        ext = _EXT.get(content_type, "jpg")
        object_key = f"wallpapers/{uid}/{uuid.uuid4().hex[:7]}.{ext}"
        client = get_minio_client()

        repo = get_user_preference_repository()
        old = await repo.get(uid, WALLPAPER_PREF_KEY, db)
        if isinstance(old, dict) and old.get("source") == "custom" and old.get("key"):
            try:
                await client.delete_object(old["key"])
            except Exception:
                logger.exception(
                    "[WALLPAPER] delete old object failed uid=%s key=%s",
                    uid,
                    old["key"],
                )

        await client.put_object(object_key, data, content_type)

        version = 1
        if isinstance(old, dict) and isinstance(old.get("version"), int):
            version = old["version"] + 1

        new_pref = {
            "source": "custom",
            "key": object_key,
            "version": version,
            "type": _type_for(content_type),
        }
        await repo.upsert(uid, WALLPAPER_PREF_KEY, new_pref, db)
        logger.info(
            "[WALLPAPER] uploaded uid=%s key=%s version=%s", uid, object_key, version
        )
        return new_pref

    async def set_preset(
        self, uid: int, preset_id: str, preset_type: str, db: AsyncSession
    ) -> dict[str, Any]:
        """Switch to a preset wallpaper; delete previous custom object if any."""
        repo = get_user_preference_repository()
        old = await repo.get(uid, WALLPAPER_PREF_KEY, db)
        if isinstance(old, dict) and old.get("source") == "custom" and old.get("key"):
            try:
                _check_minio()
                await get_minio_client().delete_object(old["key"])
            except RuntimeError:
                raise
            except Exception:
                logger.exception(
                    "[WALLPAPER] delete old custom on preset switch uid=%s", uid
                )
        new_pref = {
            "source": "preset",
            "key": preset_id,
            "version": 1,
            "type": preset_type,
        }
        await repo.upsert(uid, WALLPAPER_PREF_KEY, new_pref, db)
        logger.info("[WALLPAPER] preset selected uid=%s preset=%s", uid, preset_id)
        return new_pref

    async def serve(self, object_key: str) -> tuple[bytes, str]:
        """Fetch object bytes + content_type for the proxy endpoint."""
        _check_minio()
        client = get_minio_client()
        stat = await client.stat_object(object_key)
        content_type = (stat or {}).get("content_type") or "image/jpeg"
        data = await client.get_object(object_key)
        return data, content_type


_wallpaper_service: Optional[WallpaperService] = None


def get_wallpaper_service() -> WallpaperService:
    global _wallpaper_service
    if _wallpaper_service is None:
        _wallpaper_service = WallpaperService()
    return _wallpaper_service
