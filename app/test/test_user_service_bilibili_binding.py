from types import SimpleNamespace
from typing import Any

import pytest

from app.services.auth import user_service as user_service_module
from app.services.auth.user_service import UserService


class _FakeUserRepo:
    async def get_by_uid(self, uid: int, _db: Any) -> Any:
        return SimpleNamespace(uid=uid)


class _FakeProfileRepo:
    async def upsert(self, *_args: Any, **_kwargs: Any) -> None:
        return None


class _FakeOAuthRepo:
    def __init__(self) -> None:
        self.current_binding = SimpleNamespace(
            uid=42,
            provider="bilibili",
            provider_uid="123",
            access_token=None,
            refresh_token=None,
            expires_at=None,
            raw_data=None,
            is_primary=False,
        )
        self.created = False
        self.updated = False

    async def find_by_provider(
        self, _provider: str, provider_uid: str, _db: Any
    ) -> Any:
        if provider_uid == "456":
            return None
        return self.current_binding

    async def find_by_uid_provider(self, uid: int, provider: str, _db: Any) -> Any:
        if uid == 42 and provider == "bilibili":
            return self.current_binding
        return None

    async def update_binding(self, record: Any, _db: Any, **kwargs: Any) -> Any:
        self.updated = True
        for key, value in kwargs.items():
            setattr(record, key, value)
        return record

    async def update_tokens(self, record: Any, _db: Any, **kwargs: Any) -> Any:
        self.updated = True
        for key, value in kwargs.items():
            setattr(record, key, value)
        return record

    async def create(self, *_args: Any, **_kwargs: Any) -> None:
        self.created = True
        raise AssertionError(
            "rebinding an existing provider must not create a duplicate"
        )


@pytest.mark.asyncio
async def test_bind_oauth_to_user_replaces_existing_provider_binding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    oauth_repo = _FakeOAuthRepo()
    monkeypatch.setattr(
        user_service_module, "get_user_repository", lambda: _FakeUserRepo()
    )
    monkeypatch.setattr(
        user_service_module, "get_user_oauth_repository", lambda: oauth_repo
    )
    monkeypatch.setattr(
        user_service_module, "get_user_profile_repository", lambda: _FakeProfileRepo()
    )
    monkeypatch.setattr(user_service_module, "encrypt", lambda value: f"enc:{value}")

    service = UserService(db=object(), snowflake=object())

    await service.bind_oauth_to_user(
        uid=42,
        provider="bilibili",
        provider_uid="456",
        provider_data={"access_token": "new-sess", "refresh_token": "new-refresh"},
        profile={"nickname": "new-name"},
    )

    assert oauth_repo.created is False
    assert oauth_repo.updated is True
    assert oauth_repo.current_binding.provider_uid == "456"
    assert oauth_repo.current_binding.access_token == "enc:new-sess"
    assert oauth_repo.current_binding.refresh_token == "enc:new-refresh"
