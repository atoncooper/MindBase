"""Bilibili credential resolver — look up decrypted cookies for a user.

Absorbs ``_resolve_bili_credentials`` from ``app/routers/favorites_v2.py``.
The OAuth row lookup + AES decryption belongs in the service layer, not
the router.
"""
from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.infra.cache import cache_manager
from app.models import UserOAuth
from app.services.auth.security import decrypt as _decrypt
from app.services.bilibili import BilibiliService


_OAUTH_TTL = 600  # 10 min


def _oauth_cache_ns():
    return cache_manager.namespace("oauth_cookie", ttl=_OAUTH_TTL)


async def resolve_bili_credentials(
    uid: int, db: AsyncSession
) -> tuple[BilibiliService, int]:
    """Return a ready-to-use ``BilibiliService`` + bili_mid for ``uid``.

    Raises HTTPException(401) if the user has no linked Bilibili account.
    Uses a 10-min cache to avoid repeated DB + decrypt work.
    """
    ns = _oauth_cache_ns()

    async def _fetch():
        oauth_result = await db.execute(
            select(UserOAuth).where(
                UserOAuth.uid == uid,
                UserOAuth.provider == "bilibili",
            )
        )
        oauth = oauth_result.scalar_one_or_none()
        if not oauth or not oauth.access_token:
            return None
        sessdata = _decrypt(oauth.access_token)
        if not sessdata:
            return None
        bili_mid = (
            int(oauth.provider_uid) if oauth.provider_uid.isdigit() else 0
        )
        return (sessdata, bili_mid)

    cached = await ns.get_or_fetch(str(uid), _fetch)
    if cached is None:
        raise HTTPException(
            status_code=401, detail="Bilibili account not linked"
        )

    sessdata, bili_mid = cached
    return (
        BilibiliService(
            sessdata=sessdata, bili_jct="", dedeuserid=str(bili_mid)
        ),
        bili_mid,
    )
