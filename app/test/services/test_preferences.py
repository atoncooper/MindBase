"""Tests for UserPreferenceRepository - KV CRUD + JSON round-trip + user isolation."""

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.asyncio

from app.models import User
from app.repository.user_preference_repository import UserPreferenceRepository


@pytest_asyncio.fixture
async def repo():
    return UserPreferenceRepository()


def _random_uid() -> int:
    import random
    return random.randint(1, 10**15)


@pytest_asyncio.fixture
async def uid(test_db: AsyncSession):
    user = User(uid=_random_uid(), status="active")
    test_db.add(user)
    await test_db.commit()
    await test_db.refresh(user)
    return user.uid


class TestPreferenceCRUD:
    async def test_upsert_and_get(self, test_db: AsyncSession, repo, uid):
        await repo.upsert(
            uid,
            "wallpaper",
            {"source": "preset", "key": "default", "version": 1},
            test_db,
        )
        got = await repo.get(uid, "wallpaper", test_db)
        assert got == {"source": "preset", "key": "default", "version": 1}

    async def test_upsert_overwrites(self, test_db: AsyncSession, repo, uid):
        await repo.upsert(
            uid, "wallpaper", {"source": "preset", "key": "a", "version": 1}, test_db
        )
        await repo.upsert(
            uid,
            "wallpaper",
            {"source": "custom", "key": "wallpapers/1/abc.jpg", "version": 2},
            test_db,
        )
        got = await repo.get(uid, "wallpaper", test_db)
        assert got == {"source": "custom", "key": "wallpapers/1/abc.jpg", "version": 2}

    async def test_get_all(self, test_db: AsyncSession, repo, uid):
        await repo.upsert(
            uid, "wallpaper", {"source": "preset", "key": "default", "version": 1}, test_db
        )
        await repo.upsert(uid, "theme", "dark", test_db)
        all_prefs = await repo.get_all(uid, test_db)
        assert all_prefs["wallpaper"] == {
            "source": "preset",
            "key": "default",
            "version": 1,
        }
        assert all_prefs["theme"] == "dark"

    async def test_get_missing_returns_none(self, test_db: AsyncSession, repo, uid):
        assert await repo.get(uid, "nonexistent", test_db) is None

    async def test_get_all_empty(self, test_db: AsyncSession, repo, uid):
        assert await repo.get_all(uid, test_db) == {}

    async def test_delete(self, test_db: AsyncSession, repo, uid):
        await repo.upsert(
            uid, "wallpaper", {"source": "preset", "key": "default", "version": 1}, test_db
        )
        await repo.delete(uid, "wallpaper", test_db)
        assert await repo.get(uid, "wallpaper", test_db) is None

    async def test_isolation_between_users(self, test_db: AsyncSession, repo, uid):
        other = User(uid=_random_uid(), status="active")
        test_db.add(other)
        await test_db.commit()
        await test_db.refresh(other)
        await repo.upsert(
            uid, "wallpaper", {"source": "preset", "key": "default", "version": 1}, test_db
        )
        assert await repo.get(other.uid, "wallpaper", test_db) is None
