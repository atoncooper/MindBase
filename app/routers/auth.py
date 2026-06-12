"""
Auth router — Bilibili QR login + user system v2.

Login writes to new tables (users / user_oauth / user_profile /
user_token / rbac_user_role). The legacy user_sessions table has been removed.
"""

import hashlib

from fastapi import APIRouter, HTTPException, Depends, Header, Query, Request
from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional

from app.database import get_db, get_db_context
from app.infra.transaction import transactional_scope
from app.response import (
    LoginRequest,
    QRCodeResponse,
    LoginStatusResponse,
    TokenResponse,
    UserInfoResponse,
    ProfileUpdateRequest,
    ProfileResponse,
    PasswordSetRequest,
    PasswordChangeRequest,
    EmailBindRequest,
    PhoneBindRequest,
    SecurityOverviewResponse,
)
from app.services.bilibili import BilibiliService
from app.services.auth import UserService, validate_token as _validate_token
from app.services.auth.security import decrypt as _decrypt


def _get_device_id(request: Request) -> str:
    """Derive a stable anonymous device fingerprint from request headers."""
    ua = request.headers.get("user-agent", "")
    accept_lang = request.headers.get("accept-language", "")
    raw = f"{ua}|{accept_lang}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _get_client_ip(request: Request) -> str:
    """Extract real client IP, respecting reverse-proxy headers."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    return request.client.host if request.client else "unknown"


router = APIRouter(prefix="/auth", tags=["认证"])


# ── Token extraction ────────────────────────────────────────────


async def get_session_token(
    authorization: Optional[str] = Header(None),
    token: Optional[str] = None,
) -> str | None:
    """Extract session token from Authorization header or ?token= query param."""
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer":
            return value
    return token


async def get_current_uid(
    token_str: Optional[str] = Depends(get_session_token),
    db: AsyncSession = Depends(get_db),
) -> int:
    """FastAPI dependency: validate token and return uid, or raise 401."""
    if not token_str:
        raise HTTPException(status_code=401, detail="未提供认证 token")
    uid = await _validate_token(db, token_str)
    if uid is None:
        raise HTTPException(status_code=401, detail="token 无效或已过期")
    return uid


# ── QR Code ─────────────────────────────────────────────────────

# Share BilibiliService instances between generate and poll so that
# cookies set by B站 during QR generation are sent back during polling.
# Keyed by qrcode_key, cleaned up on confirmed / expired / error.
_qrcode_clients: dict[str, BilibiliService] = {}


def _pop_qrcode_client(qrcode_key: str) -> BilibiliService | None:
    client = _qrcode_clients.pop(qrcode_key, None)
    if client:
        # schedule close in background to avoid blocking
        import asyncio

        asyncio.ensure_future(client.close())
    return client


@router.get("/qrcode", response_model=QRCodeResponse)
async def generate_qrcode():
    """Generate a Bilibili QR login code."""
    try:
        bili = BilibiliService()
        result = await bili.generate_qrcode()

        qrcode_key = result["qrcode_key"]
        # Keep the client alive for subsequent poll calls
        _qrcode_clients[qrcode_key] = bili

        return QRCodeResponse(
            qrcode_key=qrcode_key,
            qrcode_url=result["qrcode_url"],
            qrcode_image_base64=result["qrcode_image_base64"],
        )
    except Exception as e:
        logger.exception("Failed to generate QR code")
        raise HTTPException(
            status_code=500, detail=f"Failed to generate QR code: {str(e)}"
        )


@router.get("/qrcode/poll/{qrcode_key}", response_model=LoginStatusResponse)
async def poll_qrcode_status(
    qrcode_key: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    token_str: Optional[str] = Depends(get_session_token),
    purpose: Optional[str] = Query(None),
):
    """
    Poll QR code scan status.

    On confirmed:
    1. Write user system (users / user_oauth / user_profile / user_token)
    2. Return session_token
    """
    # Remove accidental {} wrapping from frontend URL interpolation
    qrcode_key = qrcode_key.strip("{}")

    # Reuse the same BilibiliService (cookie jar) from generate
    bili = _qrcode_clients.get(qrcode_key)
    if bili is None:
        # Fallback: create a fresh client so polling still works even if
        # the server restarted and lost the in-memory client dict.
        # Cookie continuity is best-effort; B站 QR sessions are primarily
        # keyed by qrcode_key, not cookies, so this usually succeeds.
        logger.warning(
            f"[AUTH] qrcode_key={qrcode_key[:12]}... not found in cached clients "
            f"(server restart? or key mismatch?), creating fallback client"
        )
        bili = BilibiliService()
        # Don't store in _qrcode_clients — clean up after this poll
        _should_close = True
    else:
        _should_close = False
    try:
        result = await bili.poll_qrcode_status(qrcode_key)

        response = LoginStatusResponse(
            status=result["status"],
            message=result["message"],
        )

        if result["status"] == "confirmed":
            cookies = result.get("cookies", {})
            bili_mid_str = str(cookies.get("DedeUserID", ""))
            bili_mid = int(bili_mid_str) if bili_mid_str else 0

            # Fetch profile from B站 (also corrects bili_mid if cookies lacked DedeUserID)
            profile_data = {"nickname": None, "avatar": None}
            try:
                bili_auth = BilibiliService(
                    sessdata=cookies.get("SESSDATA"),
                    bili_jct=cookies.get("bili_jct"),
                    dedeuserid=bili_mid_str or None,
                )
                user_info = await bili_auth.get_user_info()
                await bili_auth.close()

                # Use mid from get_user_info as authoritative source
                api_mid = user_info.get("mid")
                if api_mid and (not bili_mid or int(api_mid) != bili_mid):
                    logger.info(
                        f"[AUTH] corrected bili_mid from {bili_mid} to {api_mid}"
                    )
                    bili_mid = int(api_mid)
                    bili_mid_str = str(api_mid)

                profile_data = {
                    "nickname": user_info.get("uname"),
                    "avatar": user_info.get("face"),
                }
            except Exception as e:
                logger.warning(f"Failed to fetch Bilibili user info: {e}")

            # Fatal if we still have no valid bili_mid
            if not bili_mid:
                raise HTTPException(
                    status_code=500, detail="Failed to identify Bilibili user"
                )

            user_service = UserService(db, (await _get_sf()))
            provider_data = {
                "access_token": cookies.get("SESSDATA"),
                "refresh_token": result.get("refresh_token"),
                "raw_data": str(user_info) if "user_info" in dir() else None,
            }
            is_binding = purpose == "bind"
            current_uid = await _validate_token(db, token_str) if token_str else None
            if is_binding and not token_str:
                raise HTTPException(status_code=401, detail="未提供认证 token")
            if (is_binding or token_str) and current_uid is None:
                raise HTTPException(status_code=401, detail="token 无效或已过期")

            if current_uid is not None:
                await user_service.bind_oauth_to_user(
                    uid=current_uid,
                    provider="bilibili",
                    provider_uid=str(bili_mid),
                    provider_data=provider_data,
                    profile=profile_data,
                )
                roles = await user_service.get_user_roles(current_uid)
                response.user_info = {
                    "uid": current_uid,
                    "mid": bili_mid,
                    "uname": profile_data["nickname"],
                    "face": profile_data["avatar"],
                    "roles": roles,
                }
            else:
                uid, user_token = await user_service.ensure_user_from_oauth(
                    provider="bilibili",
                    provider_uid=str(bili_mid),
                    provider_data=provider_data,
                    profile=profile_data,
                    device_id=_get_device_id(request),
                    ip=_get_client_ip(request),
                    user_agent=request.headers.get("user-agent"),
                )
                roles = await user_service.get_user_roles(uid)
                response.session_id = user_token.session_token
                response.user_info = {
                    "uid": uid,
                    "mid": bili_mid,
                    "uname": profile_data["nickname"],
                    "face": profile_data["avatar"],
                    "roles": roles,
                    "session_token": user_token.session_token,
                }

        # Clean up client on terminal states
        if result["status"] != "waiting":
            if _should_close:
                # Fallback client — close it ourselves
                import asyncio

                asyncio.ensure_future(bili.close())
            else:
                _pop_qrcode_client(qrcode_key)

        return response

    except HTTPException:
        if _should_close:
            import asyncio

            asyncio.ensure_future(bili.close())
        else:
            _pop_qrcode_client(qrcode_key)
        raise
    except Exception as e:
        if _should_close:
            import asyncio

            asyncio.ensure_future(bili.close())
        else:
            _pop_qrcode_client(qrcode_key)
        logger.exception("Failed to poll QR code")
        raise HTTPException(status_code=500, detail=f"Poll failed: {str(e)}")


# ── Password login ──────────────────────────────────────────────


@router.post("/login", response_model=TokenResponse)
async def login_with_password(
    req: LoginRequest,
    request: Request,
):
    """Login with email + password. Returns session token on success."""
    device_id = _get_device_id(request)
    ip = _get_client_ip(request)
    user_agent = request.headers.get("user-agent")

    try:
        async with transactional_scope() as db:
            user_service = UserService(db, (await _get_sf()))
            uid, user_token = await user_service.login_with_password(
                req.email,
                req.password,
                device_id=device_id,
                ip=ip,
                user_agent=user_agent,
            )
            info = await user_service.get_user_by_uid(uid)
            roles = await user_service.get_user_roles(uid)
    except ValueError:
        raise HTTPException(status_code=401, detail="邮箱或密码不正确")

    # Record device metadata after token commit (best-effort)
    from app.repository.user_device_repository import get_user_device_repository

    try:
        async with transactional_scope() as db:
            await get_user_device_repository().upsert(
                db,
                uid=uid,
                device_id=device_id,
                device_type=req.device.device_type if req.device else None,
                device_name=req.device.device_name if req.device else None,
                os=req.device.os if req.device else None,
                os_version=req.device.os_version if req.device else None,
                browser=req.device.browser if req.device else None,
                browser_version=req.device.browser_version if req.device else None,
                commit=False,
            )
    except Exception:
        logger.exception("[AUTH] device record failed uid={}", uid)

    return TokenResponse(
        session_token=user_token.session_token,
        token_type="access",
        expires_at=user_token.expires_at,
        user_info=UserInfoResponse(
            uid=uid,
            nickname=info.get("nickname") if info else None,
            avatar=info.get("avatar") if info else None,
            status=info.get("status", "active") if info else "active",
            roles=roles,
        ),
    )


# ── Current user ─────────────────────────────────────────────────


@router.get("/me", response_model=UserInfoResponse)
async def get_current_user(uid: int = Depends(get_current_uid)):
    """获取当前登录用户信息"""
    async with get_db_context() as db:
        user_service = UserService(db, await _get_sf())
        info = await user_service.get_user_by_uid(uid)
        if not info:
            raise HTTPException(status_code=404, detail="用户不存在")
        return UserInfoResponse(**info)


# ── Logout ──────────────────────────────────────────────────────


@router.delete("/token")
async def logout_current(
    token_str: Optional[str] = Depends(get_session_token),
    db: AsyncSession = Depends(get_db),
):
    """退出当前设备（吊销当前 token）"""
    if not token_str:
        raise HTTPException(status_code=400, detail="未提供 token")
    user_service = UserService(db, await _get_sf())
    await user_service.revoke_token(token_str)
    return {"message": "已退出登录"}


@router.delete("/tokens")
async def logout_all(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """退出所有设备（吊销该用户全部 token）"""
    user_service = UserService(db, await _get_sf())
    await user_service.revoke_all_tokens(uid)
    return {"message": "已退出所有设备"}


@router.get("/tokens")
async def list_sessions(
    token_str: str = Depends(get_session_token),
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """List all active sessions with device info."""
    user_service = UserService(db, await _get_sf())
    tokens = await user_service.list_active_tokens(uid)
    for t in tokens:
        t["is_current"] = t["session_token"] == token_str
    return {"sessions": tokens}


@router.delete("/tokens/{session_token}")
async def revoke_session(
    session_token: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Revoke a specific session by token (e.g., log out a remote device)."""
    user_service = UserService(db, await _get_sf())
    ok = await user_service.revoke_token_by_id(session_token, uid)
    if not ok:
        raise HTTPException(status_code=404, detail="会话不存在或已失效")
    return {"message": "已退出该设备"}


# ── Profile ──────────────────────────────────────────────────────


@router.get("/profile", response_model=ProfileResponse)
async def get_profile(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """获取当前用户完整个人资料"""
    user_service = UserService(db, await _get_sf())
    profile = await user_service.get_full_profile(uid)
    if not profile:
        raise HTTPException(status_code=404, detail="用户不存在")
    return ProfileResponse(**profile)


@router.patch("/profile", response_model=ProfileResponse)
async def update_profile(
    body: ProfileUpdateRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """更新个人资料（全部字段 optional）"""
    user_service = UserService(db, await _get_sf())
    profile = await user_service.update_profile(
        uid,
        **body.model_dump(exclude_none=True),
    )
    if not profile:
        raise HTTPException(status_code=404, detail="用户不存在")
    return ProfileResponse(**profile)


# ── Password ─────────────────────────────────────────────────────


@router.post("/password/set")
async def set_password(
    body: PasswordSetRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """首次设置密码（仅限未设置密码的用户）"""
    user_service = UserService(db, await _get_sf())
    try:
        await user_service.set_password(uid, body.password)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": "密码设置成功"}


@router.patch("/password")
async def change_password(
    body: PasswordChangeRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """修改密码（需验证旧密码）"""
    user_service = UserService(db, await _get_sf())
    try:
        await user_service.change_password(uid, body.old_password, body.new_password)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": "密码修改成功"}


@router.post("/password/reset-request")
async def reset_password_request(uid: int = Depends(get_current_uid)):
    """[预留] 请求密码重置邮件"""
    raise HTTPException(status_code=501, detail="密码重置功能即将上线")


@router.post("/password/reset")
async def reset_password(uid: int = Depends(get_current_uid)):
    """[预留] 执行密码重置"""
    raise HTTPException(status_code=501, detail="密码重置功能即将上线")


# ── Email ────────────────────────────────────────────────────────


@router.put("/email")
async def bind_email(
    body: EmailBindRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """直接绑定/修改邮箱（不验证）"""
    user_service = UserService(db, await _get_sf())
    try:
        await user_service.bind_email(uid, body.email)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": "邮箱绑定成功", "email": body.email}


@router.delete("/email")
async def unbind_email(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """解绑邮箱"""
    user_service = UserService(db, await _get_sf())
    try:
        await user_service.unbind_email(uid)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": "邮箱已解绑"}


@router.post("/email/send-code")
async def send_email_code(uid: int = Depends(get_current_uid)):
    """[预留] 发送邮箱验证码"""
    raise HTTPException(status_code=501, detail="邮箱验证功能即将上线")


@router.post("/email/verify")
async def verify_email(uid: int = Depends(get_current_uid)):
    """[预留] 验证邮箱并绑定"""
    raise HTTPException(status_code=501, detail="邮箱验证功能即将上线")


# ── Phone ────────────────────────────────────────────────────────


@router.put("/phone")
async def bind_phone(
    body: PhoneBindRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """直接绑定/修改手机号（不验证）"""
    user_service = UserService(db, await _get_sf())
    try:
        await user_service.bind_phone(uid, body.phone)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": "手机号绑定成功", "phone": body.phone}


@router.delete("/phone")
async def unbind_phone(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """解绑手机号"""
    user_service = UserService(db, await _get_sf())
    try:
        await user_service.unbind_phone(uid)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": "手机号已解绑"}


@router.post("/phone/send-code")
async def send_phone_code(uid: int = Depends(get_current_uid)):
    """[预留] 发送短信验证码"""
    raise HTTPException(status_code=501, detail="短信验证功能即将上线")


@router.post("/phone/verify")
async def verify_phone(uid: int = Depends(get_current_uid)):
    """[预留] 验证手机号并绑定"""
    raise HTTPException(status_code=501, detail="短信验证功能即将上线")


# ── Security overview ────────────────────────────────────────────


@router.get("/devices")
async def list_devices(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """List known devices for the current user."""
    from app.repository.user_device_repository import get_user_device_repository

    repo = get_user_device_repository()
    devices = await repo.list_by_uid(uid, db)
    return {
        "devices": [
            {
                "device_id": d.device_id,
                "device_type": d.device_type,
                "device_name": d.device_name,
                "os": d.os,
                "os_version": d.os_version,
                "browser": d.browser,
                "browser_version": d.browser_version,
                "trust_level": d.trust_level,
                "last_active_at": (
                    d.last_active_at.isoformat() if d.last_active_at else None
                ),
                "created_at": d.created_at.isoformat() if d.created_at else None,
                "is_current": False,
            }
            for d in devices
        ],
    }


@router.get("/security", response_model=SecurityOverviewResponse)
async def get_security_info(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """获取账号安全总览"""
    user_service = UserService(db, await _get_sf())
    try:
        info = await user_service.get_security_info(uid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return SecurityOverviewResponse(**info)


# ── Internal helpers ─────────────────────────────────────────────


async def _get_sf():
    from app.utils.snowflake import get_snowflake

    return await get_snowflake()


async def get_session(session_id: str) -> dict | None:
    """Get session info for internal use.

    Uses new user_tokens + user_oauth exclusively.
    Legacy user_sessions table is no longer used.
    """
    async with get_db_context() as db:
        uid = await _validate_token(db, session_id)
        if uid is None:
            return None

        from sqlalchemy import select
        from app.models import UserOAuth as UserOAuthModel

        oauth_result = await db.execute(
            select(UserOAuthModel).where(
                UserOAuthModel.uid == uid,
                UserOAuthModel.provider == "bilibili",
            )
        )
        oauth = oauth_result.scalar_one_or_none()
        if not oauth:
            return None

        user_service = UserService(db, await _get_sf())
        info = await user_service.get_user_by_uid(uid)
        sessdata = _decrypt(oauth.access_token) if oauth.access_token else ""
        return {
            "cookies": {
                "SESSDATA": sessdata,
                "bili_jct": "",
                "DedeUserID": oauth.provider_uid,
            },
            "user_info": {
                "mid": (
                    int(oauth.provider_uid) if oauth.provider_uid.isdigit() else None
                ),
                "uname": info.get("nickname") if info else None,
                "face": info.get("avatar") if info else None,
            },
        }


async def _get_bili_cookies_by_uid(uid: int, db) -> tuple:
    """Resolve B站 cookies from user_oauth by uid.

    Returns (BilibiliService, bili_mid).  Raises HTTPException(401) if no
    bilibili oauth binding exists or the access_token cannot be decrypted.
    """
    from sqlalchemy import select
    from app.models import UserOAuth as UserOAuthModel

    oauth_result = await db.execute(
        select(UserOAuthModel).where(
            UserOAuthModel.uid == uid,
            UserOAuthModel.provider == "bilibili",
        )
    )
    oauth = oauth_result.scalar_one_or_none()
    if not oauth or not oauth.access_token:
        raise HTTPException(status_code=401, detail="Bilibili account not linked")

    sessdata = _decrypt(oauth.access_token)
    if not sessdata:
        raise HTTPException(
            status_code=401, detail="Failed to decrypt Bilibili session"
        )

    bili_mid = int(oauth.provider_uid) if oauth.provider_uid.isdigit() else 0
    if not bili_mid:
        raise HTTPException(status_code=401, detail="Invalid Bilibili user ID")

    bili = BilibiliService(
        sessdata=sessdata,
        bili_jct="",
        dedeuserid=oauth.provider_uid,
    )
    return bili, bili_mid
