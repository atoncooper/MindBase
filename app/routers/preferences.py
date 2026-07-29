"""用户偏好接口 - wallpaper / theme 等 KV 偏好读写。

只做参数解析与鉴权转发，业务逻辑在 services/preferences/。
"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.response.preferences import PreferenceUpdateRequest, PreferencesResponse
from app.routers.auth import get_current_uid
from app.services.preferences.service import get_preference_service

router = APIRouter(prefix="/preferences", tags=["preferences"])


@router.get("", response_model=PreferencesResponse)
async def get_preferences(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    prefs = await get_preference_service().get_all(uid, db)
    return PreferencesResponse(preferences=prefs)


@router.patch("", response_model=PreferencesResponse)
async def update_preferences(
    req: PreferenceUpdateRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    prefs = await get_preference_service().update(uid, req.preferences, db)
    return PreferencesResponse(preferences=prefs)
