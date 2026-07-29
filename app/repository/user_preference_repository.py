"""UserPreferenceRepository - user_preferences KV table access."""

import json
from typing import Any, Optional

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import UserPreference


def _decode(raw: str) -> Any:
    """Decode a pref_value cell; fall back to raw string if not JSON."""
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return raw


class UserPreferenceRepository:
    """Data access for the user_preferences KV table."""

    async def get_all(self, uid: int, db: AsyncSession) -> dict[str, Any]:
        """Return all preferences for a user as a {key: value} dict."""
        result = await db.execute(
            select(UserPreference).where(UserPreference.uid == uid)
        )
        rows = result.scalars().all()
        out: dict[str, Any] = {}
        for row in rows:
            out[row.pref_key] = _decode(row.pref_value)
        return out

    async def get(self, uid: int, key: str, db: AsyncSession) -> Optional[Any]:
        result = await db.execute(
            select(UserPreference).where(
                UserPreference.uid == uid, UserPreference.pref_key == key
            )
        )
        row = result.scalar_one_or_none()
        if row is None:
            return None
        return _decode(row.pref_value)

    async def upsert(self, uid: int, key: str, value: Any, db: AsyncSession) -> None:
        """Create or update a preference. value is JSON-serialized."""
        value_str = json.dumps(value, ensure_ascii=False)
        result = await db.execute(
            select(UserPreference).where(
                UserPreference.uid == uid, UserPreference.pref_key == key
            )
        )
        row = result.scalar_one_or_none()
        if row is None:
            db.add(UserPreference(uid=uid, pref_key=key, pref_value=value_str))
        else:
            row.pref_value = value_str
        await db.commit()

    async def delete(self, uid: int, key: str, db: AsyncSession) -> None:
        await db.execute(
            delete(UserPreference).where(
                UserPreference.uid == uid, UserPreference.pref_key == key
            )
        )
        await db.commit()


_pref_repo: Optional[UserPreferenceRepository] = None


def get_user_preference_repository() -> UserPreferenceRepository:
    global _pref_repo
    if _pref_repo is None:
        _pref_repo = UserPreferenceRepository()
    return _pref_repo
