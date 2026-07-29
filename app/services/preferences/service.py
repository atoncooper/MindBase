"""PreferenceService - orchestrate user preference reads/writes."""

from typing import Any, Dict, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.repository.user_preference_repository import get_user_preference_repository


class PreferenceService:
    async def get_all(self, uid: int, db: AsyncSession) -> Dict[str, Any]:
        return await get_user_preference_repository().get_all(uid, db)

    async def update(
        self, uid: int, prefs: Dict[str, Any], db: AsyncSession
    ) -> Dict[str, Any]:
        repo = get_user_preference_repository()
        for key, value in prefs.items():
            await repo.upsert(uid, key, value, db)
        return await repo.get_all(uid, db)


_preference_service: Optional[PreferenceService] = None


def get_preference_service() -> PreferenceService:
    global _preference_service
    if _preference_service is None:
        _preference_service = PreferenceService()
    return _preference_service
