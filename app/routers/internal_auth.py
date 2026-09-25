"""Internal auth verify endpoint — RETIRED as the forward-auth authority.

APISIX forward-auth now validates bili_session against app-go/app-auth
(``http://app-auth:8006/internal/auth/verify``, lenient verify + X-Roles).
This endpoint is kept as a self-contained EMERGENCY FALLBACK: repoint the
forward-auth URIs in apisix/apisix.yaml back to backend:8000 to roll back.

It must validate the token directly (NOT via get_current_uid, which reads
the gateway-injected X-Uid that forward-auth does not forward here).
"""

from fastapi import APIRouter, Depends, Header
from fastapi.responses import JSONResponse
from loguru import logger
from typing import Optional

from app.database import get_db
from app.services.auth import validate_token as _validate_token
from app.repository.rbac_repository import get_rbac_repository
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/internal/auth", tags=["internal-auth"])


@router.get("/verify")
async def verify(
    authorization: Optional[str] = Header(None),
    db: AsyncSession = Depends(get_db),
):
    """Self-contained fallback: validate bili_session against user_tokens.

    200 + X-Uid (+ X-Roles) on success; 401 on missing/invalid token.
    """
    token = ""
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer":
            token = value.strip()
    if not token:
        # Lenient parity with app-auth: no credentials -> pass without identity
        return JSONResponse({"ok": False})
    uid = await _validate_token(db, token)
    if uid is None:
        return JSONResponse({"detail": "token 无效或已过期"}, status_code=401)
    try:
        roles = await get_rbac_repository().get_user_roles(uid, db)
    except Exception as exc:  # noqa: BLE001 — role failure must not block auth
        logger.warning("[AUTH_VERIFY] role lookup failed uid={} err={}", uid, exc)
        roles = []
    headers = {"X-Uid": str(uid)}
    if roles:
        headers["X-Roles"] = ",".join(roles)
    return JSONResponse({"ok": True, "uid": uid}, headers=headers)
