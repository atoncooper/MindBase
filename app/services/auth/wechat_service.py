"""WeChat Open Platform website-app OAuth client (snsapi_login).

Standard 网站应用 login flow: the frontend renders WeChat's embedded QR
(qrconnect via wxLogin.js), the user scans and confirms, WeChat redirects
the iframe to our redirect_uri with a one-time ``code``; this service
exchanges the code for access_token / openid (+ unionid when the app is
bound to an Open Platform account) and fetches profile info.

Credentials: an approved open.weixin.qq.com website app (production —
requires a verified enterprise account), or the Open Platform test account
(sandbox — the authorized callback domain can be localhost). Config via
env: WECHAT__APP_ID / WECHAT__APP_SECRET / WECHAT__REDIRECT_URI.

Also hosts the OAuth ``state`` helpers: states are random one-time tokens
stored in Redis (TTL 600s) bound to a purpose (login / bind), consumed
atomically via cas_delete — the CSRF / login-CSRF guard for the redirect
flow.
"""

from __future__ import annotations

import json
import secrets
from typing import Any

import httpx
from loguru import logger

from app.config import settings
from app.infra import redis as redis_mod

_API_BASE = "https://api.weixin.qq.com"

STATE_LOGIN = "login"
STATE_BIND = "bind"
_STATE_TTL_SECONDS = 600


class WeChatServiceError(Exception):
    """Raised when WeChat OpenAPI rejects a request or is unreachable."""


# ---------------------------------------------------------------------------
# OAuth state (CSRF guard for the redirect flow)
# ---------------------------------------------------------------------------


def _state_key(state: str) -> str:
    return redis_mod.k("auth", "wechat", "state", state)


async def issue_state(purpose: str) -> str:
    """Create a one-time OAuth state bound to *purpose* (login / bind)."""
    state = secrets.token_urlsafe(24)
    await redis_mod.jset(_state_key(state), purpose, ex=_STATE_TTL_SECONDS)
    return state


async def consume_state(state: str | None, purpose: str) -> bool:
    """Atomically consume *state* if it matches *purpose*. One-time.

    Returns False for unknown / expired / replayed / mismatched-purpose
    states, and also when Redis errors (fail-closed: the login flow cannot
    be completed securely without state verification).
    """
    if not state:
        return False
    try:
        stored = await redis_mod.jget(_state_key(state))
        if stored != purpose:
            return False
        # Expected value must match jset's JSON encoding for cas_delete.
        return await redis_mod.cas_delete(_state_key(state), json.dumps(purpose))
    except Exception as e:
        logger.warning("[WECHAT] state consume failed err={}", e)
        return False


# ---------------------------------------------------------------------------
# WeChat OpenAPI calls
# ---------------------------------------------------------------------------


def _check_errcode(payload: dict[str, Any], *, action: str) -> None:
    errcode = payload.get("errcode", 0)
    if errcode:
        logger.warning(
            "[WECHAT] {} errcode={} errmsg={}", action, errcode, payload.get("errmsg")
        )
        raise WeChatServiceError(f"微信接口返回错误（errcode={errcode}）")


class WeChatService:
    """Short-lived httpx calls; no shared state (unlike BilibiliService)."""

    async def exchange_code(self, code: str) -> dict[str, Any]:
        """Exchange the one-time authorization code for token + openid.

        Returns access_token / expires_in / refresh_token / openid /
        unionid (the latter only when the app is bound to an Open Platform
        account).
        """
        params = {
            "appid": settings.wechat_app_id,
            "secret": settings.wechat_app_secret,
            "code": code,
            "grant_type": "authorization_code",
        }
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"{_API_BASE}/sns/oauth2/access_token", params=params
                )
        except httpx.HTTPError as e:
            logger.error("[WECHAT] exchange transport error err={}", e)
            raise WeChatServiceError("微信登录服务暂不可用，请稍后重试") from e
        if resp.status_code != 200:
            logger.error("[WECHAT] exchange http status={}", resp.status_code)
            raise WeChatServiceError("微信登录服务暂不可用，请稍后重试")
        payload = resp.json()
        _check_errcode(payload, action="exchange_code")
        return payload

    async def get_user_info(self, access_token: str, openid: str) -> dict[str, Any]:
        """Fetch profile (nickname / headimgurl) for an authorized user."""
        params = {"access_token": access_token, "openid": openid, "lang": "zh_CN"}
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(f"{_API_BASE}/sns/userinfo", params=params)
        except httpx.HTTPError as e:
            logger.warning("[WECHAT] userinfo transport error err={}", e)
            raise WeChatServiceError("获取微信用户信息失败") from e
        if resp.status_code != 200:
            logger.warning("[WECHAT] userinfo http status={}", resp.status_code)
            raise WeChatServiceError("获取微信用户信息失败")
        payload = resp.json()
        _check_errcode(payload, action="userinfo")
        return payload
