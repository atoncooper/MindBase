"""
Auth router — Bilibili QR login + user system v2.

Login writes to new tables (users / user_oauth / user_profile /
user_token / rbac_user_role). The legacy user_sessions table has been removed.
"""

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Depends, Header, Query, Request
from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db, get_db_context
from app.infra.transaction import transactional_scope
from app.utils.request_meta import (
    get_client_ip as _get_client_ip,
    get_device_id as _get_device_id,
    extract_device_meta as _extract_device_meta,
)
from app.response import (
    LoginRequest,
    QRCodeResponse,
    CaptchaResponse,
    WeChatQRResponse,
    WeChatLoginRequest,
    LoginStatusResponse,
    TokenResponse,
    UserInfoResponse,
    RegisterSendCodeRequest,
    RegisterRequest,
    PhoneSendCodeRequest,
    PhoneLoginRequest,
    PhoneVerifyRequest,
    FeaturesResponse,
    ProfileUpdateRequest,
    ProfileResponse,
    PasswordSetRequest,
    PasswordChangeRequest,
    EmailBindRequest,
    EmailSendCodeRequest,
    EmailVerifyRequest,
    PasswordResetRequest,
    PasswordResetConfirmRequest,
    PhoneBindRequest,
    SecurityOverviewResponse,
)
from app.services.bilibili import BilibiliService
from app.services.auth import UserService, validate_token as _validate_token
from app.services.auth import wechat_service
from app.services.auth.captcha_service import generate_captcha, verify_captcha
from app.services.auth.security import decrypt as _decrypt
from app.services.auth.verification_service import VerificationService
from app.services.auth.rate_limit_deps import (
    change_password_rate_limit_dep_inline as _change_pw_rl,
    email_send_code_rate_limit_dep,
    email_verify_rate_limit_dep,
    login_rate_limit_dep,
    password_reset_rate_limit_dep,
    password_reset_request_email_rate_limit,
    password_reset_request_rate_limit_dep,
    phone_login_phone_rate_limit,
    phone_login_rate_limit_dep,
    phone_send_code_phone_rate_limit,
    phone_send_code_rate_limit_dep,
    register_rate_limit_dep,
    register_send_code_email_rate_limit,
    register_send_code_rate_limit_dep,
    send_code_uid_rate_limit,
)


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


async def require_admin(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
) -> int:
    """FastAPI dependency: require the caller to hold the 'admin' RBAC role.

    Returns uid on success; raises 403 otherwise. Used to gate globally
    destructive endpoints (e.g. drop Milvus collection, clear knowledge base).
    """
    from app.repository.rbac_repository import get_rbac_repository

    roles = await get_rbac_repository().get_user_roles(uid, db)
    if "admin" not in roles:
        raise HTTPException(status_code=403, detail="需要管理员权限")
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
    except Exception:
        logger.exception("Failed to generate QR code")
        raise HTTPException(
            status_code=500, detail="二维码生成失败，请稍后重试"
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
                    device_meta=_extract_device_meta(request),
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
    except Exception:
        if _should_close:
            import asyncio

            asyncio.ensure_future(bili.close())
        else:
            _pop_qrcode_client(qrcode_key)
        logger.exception("Failed to poll QR code")
        raise HTTPException(status_code=500, detail="二维码轮询失败，请稍后重试")


# ── WeChat login (open platform website app, snsapi_login) ──────


@router.get("/wechat/qrcode", response_model=WeChatQRResponse)
async def get_wechat_qrcode(
    purpose: Optional[str] = Query(None),
    token_str: Optional[str] = Depends(get_session_token),
    db: AsyncSession = Depends(get_db),
):
    """微信扫码登录参数（wxLogin.js 初始化所需）+ 一次性 state。

    未配置凭据（或 Redis 不可用无法签发 state）时返回 enabled=False，
    前端隐藏微信登录 tab。purpose=bind 签发绑定用途的 state（需登录态）。
    """
    if not settings.wechat_enabled:
        return WeChatQRResponse()

    state_purpose = wechat_service.STATE_LOGIN
    if purpose == "bind":
        current_uid = await _validate_token(db, token_str) if token_str else None
        if current_uid is None:
            raise HTTPException(status_code=401, detail="绑定操作需要登录")
        state_purpose = wechat_service.STATE_BIND

    try:
        state = await wechat_service.issue_state(state_purpose)
    except Exception:
        logger.warning("[AUTH] wechat state issue failed (redis down?)")
        return WeChatQRResponse()

    return WeChatQRResponse(
        enabled=True,
        app_id=settings.wechat_app_id,
        redirect_uri=settings.wechat_redirect_uri,
        state=state,
    )


async def _resolve_wechat_identity(code: str, state: str, purpose: str) -> tuple[dict, dict | None]:
    """Consume the state, exchange the code, fetch best-effort profile.

    Returns (token_info, profile). Raises HTTPException on any failure.
    """
    if not settings.wechat_enabled:
        raise HTTPException(status_code=400, detail="微信登录未启用")
    if not await wechat_service.consume_state(state, purpose):
        raise HTTPException(status_code=400, detail="登录状态已过期，请重新扫码")

    svc = wechat_service.WeChatService()
    try:
        token_info = await svc.exchange_code(code)
    except wechat_service.WeChatServiceError as e:
        raise HTTPException(status_code=502, detail=str(e))

    if not token_info.get("openid"):
        logger.error("[AUTH] wechat exchange returned no openid")
        raise HTTPException(status_code=502, detail="微信登录失败，请重试")

    # Profile is best-effort — login proceeds even if userinfo fails.
    profile: dict | None = None
    try:
        info = await svc.get_user_info(token_info.get("access_token", ""), token_info["openid"])
        profile = {"nickname": info.get("nickname"), "avatar": info.get("headimgurl")}
    except wechat_service.WeChatServiceError:
        logger.warning("[AUTH] wechat userinfo failed, continuing without profile")

    return token_info, profile


def _wechat_provider_data(token_info: dict) -> dict:
    expires_at = None
    if token_info.get("expires_in"):
        expires_at = datetime.now(timezone.utc) + timedelta(
            seconds=int(token_info["expires_in"])
        )
    return {
        "access_token": token_info.get("access_token"),
        "refresh_token": token_info.get("refresh_token"),
        "expires_at": expires_at,
        "union_id": token_info.get("unionid"),
        "raw_data": json.dumps(token_info, ensure_ascii=False, default=str),
    }


@router.post("/wechat/login", response_model=TokenResponse)
async def login_with_wechat(req: WeChatLoginRequest, request: Request):
    """微信扫码登录（注册）：code 换 openid，首次自动建号（free 角色）。

    重放面极小：state 与 code 均为一次性，且受 /auth 前缀双层限流保护。
    """
    token_info, profile = await _resolve_wechat_identity(
        req.code, req.state, wechat_service.STATE_LOGIN
    )
    openid = str(token_info["openid"])

    async with transactional_scope() as db:
        user_service = UserService(db, (await _get_sf()))
        uid, user_token = await user_service.ensure_user_from_oauth(
            provider="wechat",
            provider_uid=openid,
            provider_data=_wechat_provider_data(token_info),
            profile=profile,
            device_id=_get_device_id(request),
            ip=_get_client_ip(request),
            user_agent=request.headers.get("user-agent"),
            device_meta=_extract_device_meta(request),
        )
        info = await user_service.get_user_by_uid(uid)
        roles = await user_service.get_user_roles(uid)

    logger.info("[AUTH] wechat login ok uid={}", uid)
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


@router.post("/wechat/bind")
async def bind_wechat(
    req: WeChatLoginRequest,
    uid: int = Depends(get_current_uid),
):
    """将微信账号绑定到当前登录用户（为设置页预留，当前前端未接入）。"""
    token_info, profile = await _resolve_wechat_identity(
        req.code, req.state, wechat_service.STATE_BIND
    )

    async with transactional_scope() as db:
        user_service = UserService(db, (await _get_sf()))
        await user_service.bind_oauth_to_user(
            uid=uid,
            provider="wechat",
            provider_uid=str(token_info["openid"]),
            provider_data=_wechat_provider_data(token_info),
            profile=profile,
        )
    return {"message": "微信账号绑定成功"}


# ── Captcha ──────────────────────────────────────────────────────


async def _require_captcha(
    captcha_id: Optional[str],
    captcha_code: Optional[str],
    *,
    ip: str,
    endpoint: str,
) -> None:
    """Verify the graphical captcha or raise a friendly 400.

    Each captcha is single-use (consumed on success and failure), so the
    frontend refreshes the image after every submit.
    """
    if await verify_captcha(captcha_id, captcha_code):
        return
    logger.warning("[AUTH] captcha failed ip={} endpoint={}", ip, endpoint)
    if captcha_id and captcha_code:
        raise HTTPException(status_code=400, detail="图形验证码错误或已过期")
    raise HTTPException(status_code=400, detail="请输入图形验证码")


@router.get("/captcha", response_model=CaptchaResponse)
async def get_captcha():
    """获取图形验证码（data URL），用于登录 / 密码重置 / 邮箱验证码发送的人机校验。

    Redis 不可用或功能关闭时返回 required=False（前端隐藏验证码输入，
    后端校验 fail-open，由限流层兜底）。
    """
    result = await generate_captcha()
    return CaptchaResponse(
        captcha_id=result.captcha_id,
        image_base64=result.image_data_url,
        expires_in=result.expires_in,
        required=result.required,
    )


# ── Password login ──────────────────────────────────────────────


@router.post("/login", response_model=TokenResponse)
async def login_with_password(
    req: LoginRequest,
    request: Request,
    _rl: None = Depends(login_rate_limit_dep),
):
    """Login with email/phone + password. Returns session token on success.

    Brute-force defense:
      1. Per-IP rate limit (middleware/rate_limit.py, /auth prefix)
      2. Per-identifier lockout — 5 failed attempts → 15-min hard lockout
         (services/auth/login_throttle.py, Redis-backed).
      3. Single-use graphical captcha (services/auth/captcha_service.py).
    """
    from app.services.auth.login_throttle import (
        check_login_allowed,
    )

    identifier = req.email or req.phone or ""

    # Per-identifier lockout check — must happen before the password check.
    allowed, retry_after = await check_login_allowed(identifier)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="登录失败次数过多，请稍后再试",
            headers={"Retry-After": str(retry_after or 60)},
        )

    device_id = _get_device_id(request)
    ip = _get_client_ip(request)
    user_agent = request.headers.get("user-agent")

    # Anti-bot gate before any DB / bcrypt work.
    await _require_captcha(
        req.captcha_id, req.captcha_code, ip=ip, endpoint="login"
    )

    try:
        async with transactional_scope() as db:
            user_service = UserService(db, (await _get_sf()))
            uid, user_token = await user_service.login_with_password(
                identifier,
                req.password,
                device_id=device_id,
                ip=ip,
                user_agent=user_agent,
            )
            info = await user_service.get_user_by_uid(uid)
            roles = await user_service.get_user_roles(uid)
    except ValueError:
        # Record failed attempt for cooldown / audit.
        from app.services.auth.rate_limit_service import rate_limit_service
        await rate_limit_service.record_login_attempt(
            db,
            uid=None,
            # login_attempts has a single identifier column (email); phone
            # logins reuse it — String(200) fits both.
            email=identifier,
            ip=ip,
            device_id=device_id,
            success=False,
            failure_reason="invalid_credentials",
        )
        raise HTTPException(status_code=401, detail="账号或密码不正确")

    # Record successful login for audit.
    from app.services.auth.rate_limit_service import rate_limit_service
    try:
        await rate_limit_service.record_login_attempt(
            db,
            uid=uid,
            email=identifier,
            ip=ip,
            device_id=device_id,
            success=True,
        )
    except Exception:
        logger.exception("[AUTH] record_login_attempt (success) failed uid={}", uid)

    # Record device metadata after token commit (best-effort).
    # Server-parsed UA metadata is the base; client-supplied req.device
    # overrides per-field when present.
    from app.repository.user_device_repository import get_user_device_repository

    server_meta = _extract_device_meta(request)
    client_meta = req.device.model_dump() if req.device else {}
    merged: dict[str, Any] = {
        k: client_meta.get(k) or server_meta.get(k)
        for k in (
            "device_type",
            "device_name",
            "os",
            "os_version",
            "browser",
            "browser_version",
        )
    }

    try:
        async with transactional_scope() as db:
            await get_user_device_repository().upsert(
                db,
                uid=uid,
                device_id=device_id,
                device_type=merged["device_type"],
                device_name=merged["device_name"],
                os=merged["os"],
                os_version=merged["os_version"],
                browser=merged["browser"],
                browser_version=merged["browser_version"],
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


# ── Registration & phone login ───────────────────────────────────


@router.get("/features", response_model=FeaturesResponse)
async def get_auth_features():
    """登录/注册能力探测（公开、轻量）。

    前端据此显隐入口：sms 未配置时隐藏手机登录/绑定，邮件服务未配置时
    隐藏邮箱注册。
    """
    return FeaturesResponse(
        email_register_enabled=settings.email_enabled,
        sms_enabled=settings.sms_enabled,
    )


@router.post("/register/email/send-code")
async def register_send_email_code(
    body: RegisterSendCodeRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _rl: None = Depends(register_send_code_rate_limit_dep),
):
    """公开接口：发送邮箱注册验证码（purpose=register）。

    注册场景无法防枚举：邮箱已注册直接返回 409，让用户去登录/找回密码。
    """
    await _require_captcha(
        body.captcha_id,
        body.captcha_code,
        ip=_get_client_ip(request),
        endpoint="register_send",
    )
    await register_send_code_email_rate_limit(body.email, db)

    from app.repository.user_repository import get_user_repository

    if await get_user_repository().find_by_email(body.email, db):
        raise HTTPException(status_code=409, detail="该邮箱已注册，请直接登录")

    vs = VerificationService()
    try:
        await vs.send_code(db, uid=None, target=body.email, purpose="register")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": "注册验证码已发送，请查收邮件"}


@router.post("/register/email", response_model=TokenResponse)
async def register_with_email(
    req: RegisterRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _rl: None = Depends(register_rate_limit_dep),
):
    """公开接口：邮箱注册（验证码已验证所有权）→ 注册即登录。"""
    ip = _get_client_ip(request)
    await _require_captcha(
        req.captcha_id, req.captcha_code, ip=ip, endpoint="register"
    )

    vs = VerificationService()
    try:
        async with transactional_scope() as tx_db:
            vc_id = await vs.verify_code(
                tx_db,
                uid=None,
                target=req.email,
                purpose="register",
                code=req.code,
            )
            user_service = UserService(tx_db, (await _get_sf()))
            uid, user_token = await user_service.register_with_email(
                req.email,
                req.password,
                device_id=_get_device_id(request),
                ip=ip,
                user_agent=request.headers.get("user-agent"),
            )
            await vs.consume_code(tx_db, vc_id)
            info = await user_service.get_user_by_uid(uid)
            roles = await user_service.get_user_roles(uid)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    logger.info("[AUTH] email register ok uid={}", uid)
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
    """首次设置密码（仅限未设置密码的用户，强制二次验证）。

    与修改密码不同，首次设置没有旧密码这一知识因子，单靠会话 token
    不足以植入持久凭证（会话劫持场景）——因此强制验证码：已验证邮箱
    用邮箱验证码，仅有已验证手机用短信验证码，都没有则要求先绑定。
    """
    await _change_pw_rl(uid, db)
    vs = VerificationService()
    try:
        await vs.verify_and_set_password(
            db,
            uid=uid,
            new_password=body.password,
            email_code=body.email_code,
            sms_code=body.sms_code,
            sf=await _get_sf(),
        )
    except ValueError as e:
        logger.warning("[AUTH] set_password failed uid={} reason={}", uid, e)
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": "密码设置成功"}


@router.patch("/password")
async def change_password(
    body: PasswordChangeRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """修改密码（需验证旧密码 + 可选邮箱二次验证）。"""
    # Per-uid rate limit (inline — dep would need get_current_uid → cycle).
    await _change_pw_rl(uid, db)

    vs = VerificationService()
    try:
        await vs.verify_and_change_password(
            db,
            uid=uid,
            old_password=body.old_password,
            new_password=body.new_password,
            email_code=body.email_code,
            sf=await _get_sf(),
        )
    except ValueError as e:
        logger.warning(
            "[AUTH] change_password failed uid={} reason={}", uid, e,
        )
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": "密码修改成功"}


@router.post("/password/reset-request")
async def reset_password_request(
    body: PasswordResetRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _rl: None = Depends(password_reset_request_rate_limit_dep),
):
    """公开接口：请求密码重置邮件。

    即便邮箱未注册也返回相同成功信息（不泄漏账号是否存在）。
    """
    await _require_captcha(
        body.captcha_id,
        body.captcha_code,
        ip=_get_client_ip(request),
        endpoint="password_reset_request",
    )
    await password_reset_request_email_rate_limit(body.email, db)
    vs = VerificationService()
    try:
        await vs.send_reset_token(db, target=body.email)
    except ValueError as e:
        # "如果该邮箱已注册，您将收到重置邮件" 也走 200，避免账号枚举。
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": "如果该邮箱已注册，您将收到重置邮件"}


@router.post("/password/reset")
async def reset_password(
    body: PasswordResetConfirmRequest,
    db: AsyncSession = Depends(get_db),
    _rl: None = Depends(password_reset_rate_limit_dep),
):
    """公开接口：用 reset_token 设置新密码。"""
    vs = VerificationService()
    try:
        await vs.consume_token_and_reset_password(
            db,
            token=body.reset_token,
            new_password=body.new_password,
            sf=await _get_sf(),
        )
    except ValueError as e:
        logger.warning(
            "[AUTH] reset_password failed reason={} err={}", type(e).__name__, e
        )
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": "密码已重置，请使用新密码登录"}


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
async def send_email_code(
    body: EmailSendCodeRequest,
    request: Request,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
    _rl: None = Depends(email_send_code_rate_limit_dep),
):
    """发送邮箱验证码（登录态）。

    用途：
      - bind_email: 绑定/换邮箱前验证邮箱所有权
      - twofa: 敏感操作（如改密码）二次验证
    """
    # Anti-bot gate (email-bombing) before per-uid rate limit.
    await _require_captcha(
        body.captcha_id,
        body.captcha_code,
        ip=_get_client_ip(request),
        endpoint="email_send_code",
    )

    # Per-uid rate limit (inline — dep would need get_current_uid → cycle).
    await send_code_uid_rate_limit(uid, db)

    vs = VerificationService()
    try:
        await vs.send_code(
            db, uid=uid, target=body.email, purpose=body.purpose,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": "验证码已发送"}


@router.post("/email/verify")
async def verify_email(
    body: EmailVerifyRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
    _rl: None = Depends(email_verify_rate_limit_dep),
):
    """验证邮箱验证码并完成绑定（purpose=bind_email 时）。

    purpose=twofa 时仅校验，不绑定。
    """
    vs = VerificationService()
    try:
        await vs.verify_and_bind_email(
            db,
            uid=uid,
            email=body.email,
            code=body.code,
            purpose=body.purpose,
            sf=await _get_sf(),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": "验证成功", "email": body.email, "purpose": body.purpose}


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
async def send_phone_code(
    body: PhoneSendCodeRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    token_str: Optional[str] = Depends(get_session_token),
    _rl: None = Depends(phone_send_code_rate_limit_dep),
):
    """发送短信验证码。

    purpose=login（公开）：手机验证码登录/注册；
    purpose=bind / twofa（需登录态）：绑定手机号 / 敏感操作二次验证
    （如首次设置密码）。
    """
    ip = _get_client_ip(request)
    await _require_captcha(
        body.captcha_id, body.captcha_code, ip=ip, endpoint="phone_send"
    )
    await phone_send_code_phone_rate_limit(body.phone, db)

    uid: Optional[int] = None
    purpose = "login"
    if body.purpose in ("bind", "twofa"):
        uid = await _validate_token(db, token_str) if token_str else None
        if uid is None:
            raise HTTPException(status_code=401, detail="该操作需要登录")
        purpose = "bind_phone" if body.purpose == "bind" else "twofa_sms"

    vs = VerificationService()
    try:
        await vs.send_code(db, uid=uid, target=body.phone, purpose=purpose)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": "短信验证码已发送"}


@router.post("/phone/login", response_model=TokenResponse)
async def login_with_phone(
    req: PhoneLoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _rl: None = Depends(phone_login_rate_limit_dep),
):
    """公开接口：手机号验证码登录（首次自动注册，注册登录一体）。"""
    ip = _get_client_ip(request)
    await _require_captcha(
        req.captcha_id, req.captcha_code, ip=ip, endpoint="phone_login"
    )
    await phone_login_phone_rate_limit(req.phone, db)

    vs = VerificationService()
    try:
        async with transactional_scope() as tx_db:
            vc_id = await vs.verify_code(
                tx_db,
                uid=None,
                target=req.phone,
                purpose="login",
                code=req.code,
            )
            user_service = UserService(tx_db, (await _get_sf()))
            uid, user_token, _created = await user_service.login_or_register_by_phone(
                req.phone,
                device_id=_get_device_id(request),
                ip=ip,
                user_agent=request.headers.get("user-agent"),
            )
            await vs.consume_code(tx_db, vc_id)
            info = await user_service.get_user_by_uid(uid)
            roles = await user_service.get_user_roles(uid)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    logger.info("[AUTH] phone code login ok uid={}", uid)
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


@router.post("/phone/verify")
async def verify_phone(
    body: PhoneVerifyRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
    _rl: None = Depends(email_verify_rate_limit_dep),
):
    """验证短信验证码并绑定手机号（登录态）。"""
    vs = VerificationService()
    try:
        async with transactional_scope() as tx_db:
            vc_id = await vs.verify_code(
                tx_db,
                uid=uid,
                target=body.phone,
                purpose="bind_phone",
                code=body.code,
            )
            user_service = UserService(tx_db, await _get_sf())
            await user_service.apply_verified_phone(uid, body.phone)
            await vs.consume_code(tx_db, vc_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": "手机号验证成功", "phone": body.phone}


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

    Thin wrapper over ``app.services.auth.bilibili_credentials.resolve_bili_credentials``
    — kept here so existing callers (knowledge / cloud routers) don't need
    to change their import paths. The actual DB access + AES decryption
    lives in the service layer.
    """
    from app.services.auth.bilibili_credentials import resolve_bili_credentials

    return await resolve_bili_credentials(uid, db)
