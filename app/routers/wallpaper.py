"""壁纸接口 - 上传自定义壁纸 / 选预设 / 代理访问 / 预设列表。

上传与预设切换经 MinIO；自定义壁纸内容经 ``/wallpaper/file/{key}`` 代理
返回（公开读，UUID 防遍历），便于 nginx proxy_cache 缓存。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.routers.auth import get_current_uid
from app.services.wallpaper.service import get_wallpaper_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/wallpaper", tags=["wallpaper"])

PRESETS = [
    {"id": "default", "name": "默认风景", "type": "image"},
    {"id": "sonoma", "name": "Sonoma", "type": "image"},
    {"id": "monterey", "name": "Monterey", "type": "image"},
    {"id": "ventura", "name": "Ventura", "type": "image"},
    {"id": "sonoma-dynamic", "name": "Sonoma 动态", "type": "video"},
    {"id": "monterey-dynamic", "name": "Monterey 动态", "type": "video"},
    {"id": "ventura-dynamic", "name": "Ventura 动态", "type": "video"},
]


class PresetSelectRequest(BaseModel):
    preset_id: str


@router.get("/presets")
async def list_presets():
    """Return the built-in preset wallpaper list (drives the picker UI)."""
    return {"presets": PRESETS}


@router.post("/upload")
async def upload_wallpaper(
    file: UploadFile = File(...),
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Upload a custom wallpaper for the caller (MinIO + preference update)."""
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="空文件")
    try:
        pref = await get_wallpaper_service().upload(
            uid, data, file.content_type or "application/octet-stream", db
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as exc:
        logger.exception("[WALLPAPER] upload failed uid=%s", uid)
        raise HTTPException(status_code=502, detail=f"上传失败: {exc}") from exc
    return {"wallpaper": pref}


@router.post("/preset")
async def select_preset(
    req: PresetSelectRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Switch to a preset wallpaper (deletes previous custom object if any)."""
    preset = next((p for p in PRESETS if p["id"] == req.preset_id), None)
    if preset is None:
        raise HTTPException(status_code=404, detail=f"未知预设: {req.preset_id}")
    try:
        pref = await get_wallpaper_service().set_preset(
            uid, req.preset_id, preset["type"], db
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as exc:
        logger.exception("[WALLPAPER] preset select failed uid=%s", uid)
        raise HTTPException(status_code=502, detail=f"设置失败: {exc}") from exc
    return {"wallpaper": pref}


@router.get("/file/{object_key:path}")
async def serve_wallpaper(object_key: str):
    """Proxy a wallpaper object from MinIO (public read for nginx cacheability).

    No auth: wallpaper content is treated as non-sensitive (like an avatar).
    Restricted to the ``wallpapers/`` prefix so other bucket objects
    (skills/ etc.) cannot be accessed here.
    """
    if not object_key.startswith("wallpapers/"):
        raise HTTPException(status_code=404, detail="Not found")
    try:
        data, content_type = await get_wallpaper_service().serve(object_key)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="壁纸不存在")
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as exc:
        logger.exception("[WALLPAPER] serve failed key=%s", object_key)
        raise HTTPException(status_code=502, detail="读取失败") from exc
    return Response(
        content=data,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=604800"},
    )
