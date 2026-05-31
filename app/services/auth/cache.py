"""
Auth cache accessors — thin helpers over the unified cache_manager.

Namespaces:
  token   = token:session_token → uid
  user    = user:uid            → user info dict
"""

from app.infra.cache import cache_manager

# Shortcuts — created lazily on first access via cache_manager.namespace()

_TOKEN_TTL = 300   # 5 min — token → uid mapping
_USER_TTL = 300    # 5 min — uid → user info


def _token() -> "NamespaceCache":
    from app.infra.cache import NamespaceCache
    return cache_manager.namespace("token", ttl=_TOKEN_TTL)


def _user() -> "NamespaceCache":
    from app.infra.cache import NamespaceCache
    return cache_manager.namespace("user", ttl=_USER_TTL)


# ── Public API ───────────────────────────────────────────────────

async def get_token_uid(session_token: str) -> int | None:
    return await _token().get_int(session_token)


async def set_token_uid(session_token: str, uid: int) -> None:
    await _token().set(session_token, uid)


async def delete_token(session_token: str) -> None:
    await _token().delete(session_token)


async def delete_all_tokens() -> None:
    await _token().clear()


async def get_user(uid: int) -> dict | None:
    return await _user().get_dict(str(uid))


async def set_user(uid: int, data: dict) -> None:
    await _user().set(str(uid), data)


async def delete_user(uid: int) -> None:
    await _user().delete(str(uid))
