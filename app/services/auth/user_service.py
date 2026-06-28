"""
UserService — unified user lifecycle, OAuth binding, token, and role management.

Orchestration layer: holds business rules and delegates all DB access to
Repository classes. No raw SQL or session.query() calls live here.
"""

from typing import Optional
import re

from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models import UserToken
from app.utils.snowflake import SnowflakeGenerator
from app.services.auth.security import encrypt, decrypt
from app.services.auth.token import (
    create_token,
    validate_token,
    revoke_token,
    revoke_all_tokens,
)  # noqa: F401

from app.repository.user_repository import get_user_repository
from app.repository.user_oauth_repository import get_user_oauth_repository
from app.repository.user_profile_repository import get_user_profile_repository
from app.repository.user_token_repository import get_user_token_repository
from app.repository.rbac_repository import get_rbac_repository, DEFAULT_ROLE


# Password strength policy — enforced on set and change.
_PASSWORD_MIN_LEN = 8
_PASSWORD_MAX_LEN = 128
_PASSWORD_LETTER_RE = re.compile(r"[A-Za-z]")
_PASSWORD_DIGIT_RE = re.compile(r"[0-9]")


def _validate_password_strength(password: str) -> None:
    """Raise ValueError if password fails strength policy.

    Policy: 8-128 chars, must contain both a letter and a digit, no leading/
    trailing whitespace. Intended to be called inside service methods that
    already wrap ValueError → HTTPException(400) at the router layer.
    """
    if not isinstance(password, str) or not password:
        raise ValueError("密码不能为空")
    if password != password.strip():
        raise ValueError("密码首尾不能包含空白字符")
    if len(password) < _PASSWORD_MIN_LEN:
        raise ValueError(f"密码至少 {_PASSWORD_MIN_LEN} 位")
    if len(password) > _PASSWORD_MAX_LEN:
        raise ValueError(f"密码不能超过 {_PASSWORD_MAX_LEN} 位")
    if not _PASSWORD_LETTER_RE.search(password):
        raise ValueError("密码必须同时包含字母和数字")
    if not _PASSWORD_DIGIT_RE.search(password):
        raise ValueError("密码必须同时包含字母和数字")


class UserService:
    """User lifecycle service — stateless, repositories injected per-call."""

    def __init__(self, db: AsyncSession, snowflake: SnowflakeGenerator) -> None:
        self.db = db
        self.snowflake = snowflake

    # ── Idempotent entry point ───────────────────────────────────

    async def ensure_user_from_oauth(
        self,
        *,
        provider: str,
        provider_uid: str,
        provider_data: dict | None = None,
        profile: dict | None = None,
        device_id: str | None = None,
        ip: str | None = None,
        user_agent: str | None = None,
        device_meta: dict | None = None,
    ) -> tuple[int, UserToken]:
        """Find or create a user via OAuth binding, then issue a session token.

        Idempotent: repeated calls for the same (provider, provider_uid) return
        the same uid with a fresh token each time.
        """
        oauth_repo = get_user_oauth_repository()
        user_repo = get_user_repository()
        profile_repo = get_user_profile_repository()
        rbac_repo = get_rbac_repository()

        existing = await oauth_repo.find_by_provider(provider, provider_uid, self.db)

        if existing:
            uid = existing.uid
            if provider_data:
                access_token_enc = (
                    encrypt(provider_data["access_token"])
                    if provider_data.get("access_token")
                    else None
                )
                refresh_token_enc = (
                    encrypt(provider_data["refresh_token"])
                    if provider_data.get("refresh_token")
                    else None
                )
                await oauth_repo.update_tokens(
                    existing,
                    self.db,
                    access_token=access_token_enc,
                    refresh_token=refresh_token_enc,
                    expires_at=provider_data.get("expires_at"),
                    raw_data=provider_data.get("raw_data"),
                )
            if profile:
                await profile_repo.upsert(uid, self.db, **self._pick_profile(profile))
            logger.info(f"[USER] existing user uid={uid} via {provider}:{provider_uid}")
        else:
            uid = await self.snowflake.next_id()
            await user_repo.create(uid, self.db)

            await oauth_repo.create(
                uid,
                self.db,
                provider=provider,
                provider_uid=provider_uid,
                access_token=(
                    encrypt(provider_data["access_token"])
                    if provider_data and provider_data.get("access_token")
                    else None
                ),
                refresh_token=(
                    encrypt(provider_data["refresh_token"])
                    if provider_data and provider_data.get("refresh_token")
                    else None
                ),
                expires_at=provider_data.get("expires_at") if provider_data else None,
                raw_data=provider_data.get("raw_data") if provider_data else None,
                is_primary=True,
            )
            await profile_repo.upsert(
                uid, self.db, **(self._pick_profile(profile) if profile else {})
            )
            await rbac_repo.grant_role(uid, DEFAULT_ROLE, self.db, granted_by=0)
            logger.info(f"[USER] created uid={uid} via {provider}:{provider_uid}")

        token = await create_token(
            self.db,
            uid=uid,
            device_id=device_id,
            ip=ip,
            user_agent=user_agent,
        )
        # Record device info for device management
        if device_id:
            await self._record_device(
                uid=uid, device_id=device_id, device_meta=device_meta
            )
        return uid, token

    # ── Queries ──────────────────────────────────────────────────

    async def get_user_by_uid(self, uid: int) -> Optional[dict]:
        """Return user info dict, or None if not found / soft-deleted.

        Hot-path caching: checks L1 local memory cache first.
        """
        from app.services.auth import cache as auth_cache

        cached = await auth_cache.get_user(uid)
        if cached is not None:
            return cached

        user = await get_user_repository().get_by_uid(uid, self.db)
        if not user:
            return None
        profile = await get_user_profile_repository().get_by_uid(uid, self.db)
        roles = await self.get_user_roles(uid)
        data = {
            "uid": user.uid,
            "status": user.status,
            "created_at": user.created_at.isoformat() if user.created_at else None,
            "nickname": profile.nickname if profile else None,
            "avatar": profile.avatar if profile else None,
            "roles": roles,
        }
        await auth_cache.set_user(uid, data)
        return data

    @staticmethod
    async def _invalidate_user_cache(uid: int) -> None:
        from app.services.auth import cache as auth_cache

        await auth_cache.delete_user(uid)

    async def get_user_by_oauth(
        self, provider: str, provider_uid: str
    ) -> Optional[dict]:
        """Find user by OAuth binding."""
        oauth = await get_user_oauth_repository().find_by_provider(
            provider, provider_uid, self.db
        )
        if not oauth:
            return None
        return await self.get_user_by_uid(oauth.uid)

    async def bind_oauth_to_user(
        self,
        *,
        uid: int,
        provider: str,
        provider_uid: str,
        provider_data: dict | None = None,
        profile: dict | None = None,
    ) -> None:
        user = await get_user_repository().get_by_uid(uid, self.db)
        if not user:
            raise ValueError("用户不存在")

        oauth_repo = get_user_oauth_repository()
        existing = await oauth_repo.find_by_provider(provider, provider_uid, self.db)
        access_token_enc = (
            encrypt(provider_data["access_token"])
            if provider_data and provider_data.get("access_token")
            else None
        )
        refresh_token_enc = (
            encrypt(provider_data["refresh_token"])
            if provider_data and provider_data.get("refresh_token")
            else None
        )

        if existing:
            if existing.uid != uid:
                raise ValueError("该第三方账号已绑定其他用户")
            await oauth_repo.update_tokens(
                existing,
                self.db,
                access_token=access_token_enc,
                refresh_token=refresh_token_enc,
                expires_at=provider_data.get("expires_at") if provider_data else None,
                raw_data=provider_data.get("raw_data") if provider_data else None,
            )
        else:
            current_binding = await oauth_repo.find_by_uid_provider(
                uid, provider, self.db
            )
            if current_binding:
                await oauth_repo.update_binding(
                    current_binding,
                    self.db,
                    provider_uid=provider_uid,
                    access_token=access_token_enc,
                    refresh_token=refresh_token_enc,
                    expires_at=(
                        provider_data.get("expires_at") if provider_data else None
                    ),
                    raw_data=provider_data.get("raw_data") if provider_data else None,
                )
            else:
                await oauth_repo.create(
                    uid,
                    self.db,
                    provider=provider,
                    provider_uid=provider_uid,
                    access_token=access_token_enc,
                    refresh_token=refresh_token_enc,
                    expires_at=(
                        provider_data.get("expires_at") if provider_data else None
                    ),
                    raw_data=provider_data.get("raw_data") if provider_data else None,
                    is_primary=False,
                )

        if profile:
            await get_user_profile_repository().upsert(
                uid, self.db, **self._pick_profile(profile)
            )
        await self._invalidate_user_cache(uid)
        logger.info(f"[USER] bound oauth uid={uid} via {provider}:{provider_uid}")

    async def get_user_roles(self, uid: int) -> list[str]:
        """Return active role IDs for a user."""
        return await get_rbac_repository().get_user_roles(uid, self.db)

    # ── Permission check ─────────────────────────────────────────

    async def has_permission(self, uid: int, _action: str) -> bool:
        """Check whether a user can perform an action.

        Currently a stub — all roles pass. When paid tiers are introduced,
        populate rbac_permission / rbac_role_permission and replace this logic.
        """
        roles = await self.get_user_roles(uid)
        if "admin" in roles:
            return True
        return True  # free tier: all actions allowed for now

    # ── Login ──────────────────────────────────────────────────

    async def login_with_password(
        self,
        email: str,
        password: str,
        *,
        device_id: str | None = None,
        ip: str | None = None,
        user_agent: str | None = None,
    ) -> tuple[int, UserToken]:
        """Login via email + password. Raises ValueError on failure."""
        from app.services.auth.security import verify_password as _verify

        user = await get_user_repository().find_by_email(email, self.db)
        if not user or not user.password_hash:
            raise ValueError("邮箱未注册或未设置密码")
        if not _verify(password, user.password_hash):
            raise ValueError("密码不正确")
        token = await create_token(
            self.db,
            uid=user.uid,
            device_id=device_id,
            ip=ip,
            user_agent=user_agent,
            commit=False,
        )
        logger.info(f"[USER] password login uid={user.uid}")
        return user.uid, token

    # ── Token helpers ────────────────────────────────────────────

    async def validate_token(self, session_token: str) -> Optional[int]:
        return await validate_token(self.db, session_token)

    async def revoke_token(self, session_token: str) -> None:
        await revoke_token(self.db, session_token)

    async def revoke_token_by_id(self, session_token: str, uid: int) -> bool:
        """Revoke a specific token with ownership verification."""
        repo = get_user_token_repository()
        return await repo.revoke_by_id(session_token, uid, self.db)

    async def revoke_all_tokens(self, uid: int) -> None:
        await revoke_all_tokens(self.db, uid)

    async def list_active_tokens(self, uid: int) -> list[dict]:
        """List active tokens with device info for the user."""
        repo = get_user_token_repository()
        tokens = await repo.list_active(uid, self.db)
        return [
            {
                "session_token": t.session_token,
                "device_id": t.device_id,
                "ip": t.ip,
                "user_agent": t.user_agent,
                "created_at": t.created_at,
                "last_active_at": t.last_active_at,
                "expires_at": t.expires_at,
                "is_current": False,
            }
            for t in tokens
        ]

    # ── Profile ───────────────────────────────────────────────────

    async def get_full_profile(self, uid: int) -> Optional[dict]:
        """Return full profile (users + user_profile) for the given uid."""
        user = await get_user_repository().get_by_uid(uid, self.db)
        if not user:
            return None
        profile = await get_user_profile_repository().get_by_uid(uid, self.db)
        return {
            "uid": user.uid,
            "email": user.email,
            "email_verified": bool(user.email_verified),
            "phone": user.phone,
            "phone_verified": bool(user.phone_verified),
            "nickname": profile.nickname if profile else None,
            "avatar": profile.avatar if profile else None,
            "bio": profile.bio if profile else None,
            "birthday": profile.birthday if profile else None,
            "gender": profile.gender if profile else None,
            "location": profile.location if profile else None,
            "timezone": profile.timezone if profile else None,
            "language": profile.language if profile else None,
            "status": user.status,
            "created_at": user.created_at,
        }

    async def update_profile(self, uid: int, **fields) -> Optional[dict]:
        """Update user_profile fields. Returns updated full profile."""
        user = await get_user_repository().get_by_uid(uid, self.db)
        if not user:
            return None
        profile_keys = {
            "nickname",
            "avatar",
            "bio",
            "birthday",
            "gender",
            "location",
            "timezone",
            "language",
        }
        profile_fields = {
            k: v for k, v in fields.items() if k in profile_keys and v is not None
        }
        if profile_fields:
            await get_user_profile_repository().upsert(uid, self.db, **profile_fields)
        await self._invalidate_user_cache(uid)
        return await self.get_full_profile(uid)

    # ── Password ──────────────────────────────────────────────────

    async def set_password(self, uid: int, password: str) -> None:
        """Set password for the first time (only if no password exists)."""
        from app.services.auth.security import hash_password as _hash

        _validate_password_strength(password)
        user = await get_user_repository().get_by_uid(uid, self.db)
        if not user:
            raise ValueError("用户不存在")
        if user.password_hash:
            raise ValueError("密码已设置，请使用修改密码接口")
        await get_user_repository().update(
            uid,
            self.db,
            password_hash=_hash(password),
        )
        await self._invalidate_user_cache(uid)
        logger.info(f"[USER] password set for uid={uid}")

    async def change_password(
        self, uid: int, old_password: str, new_password: str
    ) -> None:
        """Change password (requires old_password verification)."""
        from app.services.auth.security import (
            verify_password as _verify,
            hash_password as _hash,
        )

        _validate_password_strength(new_password)
        if old_password == new_password:
            raise ValueError("新密码不能与旧密码相同")
        user = await get_user_repository().get_by_uid(uid, self.db)
        if not user:
            raise ValueError("用户不存在")
        if not user.password_hash:
            raise ValueError("未设置密码，请使用密码设置接口")
        if not _verify(old_password, user.password_hash):
            raise ValueError("旧密码不正确")
        if _verify(new_password, user.password_hash):
            raise ValueError("新密码不能与旧密码相同")
        await get_user_repository().update(
            uid,
            self.db,
            password_hash=_hash(new_password),
        )
        await self._invalidate_user_cache(uid)
        logger.info(f"[USER] password changed for uid={uid}")

    async def reset_password(self, uid: int, new_password: str) -> None:
        """Reset password without old_password verification.

        Caller MUST have verified the reset token before calling this.
        Used by the forgot-password flow.
        """
        from app.services.auth.security import (
            hash_password as _hash,
            verify_password as _verify,
        )

        _validate_password_strength(new_password)
        user = await get_user_repository().get_by_uid(uid, self.db)
        if not user:
            raise ValueError("用户不存在")
        # If user had a password, refuse to reuse it.
        if user.password_hash and _verify(new_password, user.password_hash):
            raise ValueError("新密码不能与旧密码相同")
        await get_user_repository().update(
            uid,
            self.db,
            password_hash=_hash(new_password),
        )
        await self._invalidate_user_cache(uid)
        logger.info(f"[USER] password reset for uid={uid}")

    # ── Email / Phone ─────────────────────────────────────────────

    async def bind_email(self, uid: int, email: str) -> None:
        """Directly bind/change email (no verification)."""
        from sqlalchemy.exc import IntegrityError

        try:
            user = await get_user_repository().update(
                uid,
                self.db,
                email=email,
                email_verified=False,
            )
            if not user:
                raise ValueError("用户不存在")
        except IntegrityError:
            raise ValueError("该邮箱已被其他账号绑定")
        await self._invalidate_user_cache(uid)
        logger.info(f"[USER] email bound for uid={uid}")

    async def apply_verified_email(self, uid: int, email: str) -> None:
        """Bind email AND mark email_verified=true.

        Called by the verify-email flow after the user has proven control
        of the inbox via verification code. Rejects emails already taken
        by another account.
        """
        from sqlalchemy.exc import IntegrityError

        try:
            user = await get_user_repository().update(
                uid,
                self.db,
                email=email,
                email_verified=True,
            )
            if not user:
                raise ValueError("用户不存在")
        except IntegrityError:
            raise ValueError("该邮箱已被其他账号绑定")
        await self._invalidate_user_cache(uid)
        logger.info(f"[USER] email verified for uid={uid}")

    async def bind_phone(self, uid: int, phone: str) -> None:
        """Directly bind/change phone (no verification)."""
        from sqlalchemy.exc import IntegrityError

        try:
            user = await get_user_repository().update(
                uid,
                self.db,
                phone=phone,
                phone_verified=False,
            )
            if not user:
                raise ValueError("用户不存在")
        except IntegrityError:
            raise ValueError("该手机号已被其他账号绑定")
        await self._invalidate_user_cache(uid)
        logger.info(f"[USER] phone bound for uid={uid}")

    async def unbind_email(self, uid: int) -> None:
        """Unbind email (with safety check)."""
        user = await get_user_repository().get_by_uid(uid, self.db)
        if not user:
            raise ValueError("用户不存在")
        if not user.email:
            return
        await self._check_can_unbind(uid)
        await get_user_repository().update(
            uid,
            self.db,
            email=None,
            email_verified=False,
        )
        await self._invalidate_user_cache(uid)
        logger.info(f"[USER] email unbound for uid={uid}")

    async def unbind_phone(self, uid: int) -> None:
        """Unbind phone (with safety check)."""
        user = await get_user_repository().get_by_uid(uid, self.db)
        if not user:
            raise ValueError("用户不存在")
        if not user.phone:
            return
        await self._check_can_unbind(uid)
        await get_user_repository().update(
            uid,
            self.db,
            phone=None,
            phone_verified=False,
        )
        await self._invalidate_user_cache(uid)
        logger.info(f"[USER] phone unbound for uid={uid}")

    async def _check_can_unbind(self, uid: int) -> None:
        """Ensure user still has at least one login method after unbinding."""
        user = await get_user_repository().get_by_uid(uid, self.db)
        if not user:
            raise ValueError("用户不存在")
        remaining = 0
        if user.password_hash:
            remaining += 1
        remaining += await get_user_oauth_repository().count_by_uid(uid, self.db)
        if remaining <= 1:
            raise ValueError("至少保留一种登录方式（密码或第三方绑定），无法解绑")

    # ── Security overview ─────────────────────────────────────────

    async def get_security_info(self, uid: int) -> dict:
        """Return account security overview."""
        user = await get_user_repository().get_by_uid(uid, self.db)
        if not user:
            raise ValueError("用户不存在")

        oauth_repo = get_user_oauth_repository()
        bindings = await oauth_repo.list_by_uid(uid, self.db)
        oauth_list = []
        bilibili_status = {
            "bound": False,
            "valid": False,
            "mid": None,
            "nickname": None,
            "avatar": None,
            "message": "未绑定B站账号",
        }
        for b in bindings:
            oauth_list.append(
                {
                    "provider": b.provider,
                    "email": getattr(b, "email", None),
                    "is_primary": bool(b.is_primary),
                }
            )
            if b.provider == "bilibili":
                bilibili_status = await self._get_bilibili_status(b)

        return {
            "email": user.email,
            "email_verified": bool(user.email_verified),
            "phone": user.phone,
            "phone_verified": bool(user.phone_verified),
            "has_password": bool(user.password_hash),
            "oauth_bindings": oauth_list,
            "bilibili": bilibili_status,
        }

    async def _get_bilibili_status(self, binding) -> dict:
        status = {
            "bound": True,
            "valid": False,
            "mid": (
                int(binding.provider_uid)
                if str(binding.provider_uid).isdigit()
                else None
            ),
            "nickname": None,
            "avatar": None,
            "message": "B站登录已失效，请重新扫码",
        }
        if not binding.access_token:
            return status

        try:
            sessdata = decrypt(binding.access_token)
            from app.services.bilibili import BilibiliService

            bili = BilibiliService(sessdata=sessdata, dedeuserid=binding.provider_uid)
            try:
                data = await bili.get_user_info()
            finally:
                await bili.close()
            return {
                **status,
                "valid": True,
                "mid": data.get("mid") or status["mid"],
                "nickname": data.get("uname"),
                "avatar": data.get("face"),
                "message": "B站账号已绑定",
            }
        except Exception as exc:
            logger.warning(f"[USER] bilibili binding invalid uid={binding.uid}: {exc}")
            return status

    # ── Internal helpers ─────────────────────────────────────────

    async def _record_device(
        self,
        *,
        uid: int,
        device_id: str,
        device_meta: dict | None = None,
    ) -> None:
        """Ensure a user_device row exists for the given fingerprint.
        Best-effort — failures are logged but never block login.
        """
        try:
            from app.repository.user_device_repository import get_user_device_repository

            repo = get_user_device_repository()
            meta = device_meta or {}
            await repo.upsert(
                self.db,
                uid=uid,
                device_id=device_id,
                device_type=meta.get("device_type"),
                device_name=meta.get("device_name"),
                os=meta.get("os"),
                os_version=meta.get("os_version"),
                browser=meta.get("browser"),
                browser_version=meta.get("browser_version"),
                commit=False,
            )
        except Exception:
            logger.exception("[USER] failed to record device uid={}", uid)

    @staticmethod
    def _pick_profile(data: dict) -> dict:
        """Extract only known profile keys from raw data dict."""
        out = {}
        for key in ("nickname", "avatar", "bio"):
            if key in data and data[key] is not None:
                out[key] = data[key]
        return out
