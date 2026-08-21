"""Tests for /internal/auth/verify (APISIX forward-auth target)."""

import json

import pytest

from app.routers.internal_auth import verify


@pytest.mark.asyncio
async def test_verify_returns_x_uid_header():
    """verify() echoes uid as X-Uid header (APISIX forward-auth reads it)."""
    resp = await verify(uid=123)
    assert resp.status_code == 200
    assert resp.headers["X-Uid"] == "123"


@pytest.mark.asyncio
async def test_verify_body_contains_uid():
    resp = await verify(uid=456)
    body = json.loads(resp.body)
    assert body == {"ok": True, "uid": 456}


@pytest.mark.asyncio
async def test_verify_distinct_uids():
    for uid in (1, 99999, 2**31):
        resp = await verify(uid=uid)
        assert resp.headers["X-Uid"] == str(uid)
