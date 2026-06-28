"""
Pydantic schemas for auth API — request / response models.
"""

from datetime import datetime, date
from typing import Optional
from pydantic import BaseModel, Field, field_validator


def normalize_email(value: str) -> str:
    email = value.strip().lower()
    if not email:
        raise ValueError("邮箱不能为空")
    if "@" not in email or email.startswith("@") or email.endswith("@"):
        raise ValueError("邮箱格式不正确")
    local, domain = email.rsplit("@", 1)
    if (
        "@" in local
        or not local
        or "." not in domain
        or domain.startswith(".")
        or domain.endswith(".")
    ):
        raise ValueError("邮箱格式不正确")
    if any(part == "" for part in domain.split(".")) or any(
        ch.isspace() for ch in email
    ):
        raise ValueError("邮箱格式不正确")
    return email


class QRCodeResponse(BaseModel):
    """GET /auth/qrcode response."""

    qrcode_key: str
    qrcode_url: str
    qrcode_image_base64: str


class LoginStatusResponse(BaseModel):
    """GET /auth/qrcode/poll/{key} response."""

    status: str  # waiting | scanned | confirmed | expired
    message: str
    user_info: Optional[dict] = None
    session_id: Optional[str] = None


class UserInfoResponse(BaseModel):
    """GET /auth/me response."""

    uid: int
    nickname: Optional[str] = None
    avatar: Optional[str] = None
    status: str = "active"
    roles: list[str] = ["free"]
    primary_oauth: Optional[str] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class TokenResponse(BaseModel):
    """Login success token envelope."""

    session_token: str
    token_type: str = "access"
    expires_at: Optional[datetime] = None
    user_info: UserInfoResponse


class ProfileUpdateRequest(BaseModel):
    """PATCH /auth/profile request — all fields optional."""

    nickname: Optional[str] = None
    avatar: Optional[str] = None
    bio: Optional[str] = None
    birthday: Optional[date] = None
    gender: Optional[str] = None
    location: Optional[str] = None
    timezone: Optional[str] = None
    language: Optional[str] = None


class ProfileResponse(BaseModel):
    """GET /auth/profile response."""

    uid: int
    email: Optional[str] = None
    email_verified: bool = False
    phone: Optional[str] = None
    phone_verified: bool = False
    nickname: Optional[str] = None
    avatar: Optional[str] = None
    bio: Optional[str] = None
    birthday: Optional[date] = None
    gender: Optional[str] = None
    location: Optional[str] = None
    timezone: Optional[str] = None
    language: Optional[str] = None
    status: str = "active"
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class PasswordSetRequest(BaseModel):
    """POST /auth/password/set request."""

    password: str = Field(..., min_length=1, max_length=128)


class PasswordChangeRequest(BaseModel):
    """PATCH /auth/password request."""

    old_password: str = Field(..., min_length=1, max_length=128)
    new_password: str = Field(..., min_length=1, max_length=128)
    # Optional email verification code for 2FA on sensitive operations.
    # Required when the user has email_verified=true; ignored otherwise.
    email_code: Optional[str] = None


class EmailBindRequest(BaseModel):
    """PUT /auth/email request."""

    email: str

    @field_validator("email")
    @classmethod
    def normalize_email_value(cls, value: str) -> str:
        return normalize_email(value)


class EmailSendCodeRequest(BaseModel):
    """POST /auth/email/send-code request."""

    email: str
    purpose: str = "bind_email"  # bind_email | twofa

    @field_validator("email")
    @classmethod
    def normalize_email_value(cls, value: str) -> str:
        return normalize_email(value)

    @field_validator("purpose")
    @classmethod
    def validate_purpose(cls, v: str) -> str:
        if v not in {"bind_email", "twofa"}:
            raise ValueError("purpose must be bind_email or twofa")
        return v


class EmailVerifyRequest(BaseModel):
    """POST /auth/email/verify request."""

    email: str
    code: str
    purpose: str = "bind_email"

    @field_validator("email")
    @classmethod
    def normalize_email_value(cls, value: str) -> str:
        return normalize_email(value)

    @field_validator("code")
    @classmethod
    def normalize_code(cls, v: str) -> str:
        return v.strip()

    @field_validator("purpose")
    @classmethod
    def validate_purpose(cls, v: str) -> str:
        if v not in {"bind_email", "twofa"}:
            raise ValueError("purpose must be bind_email or twofa")
        return v


class PasswordResetRequest(BaseModel):
    """POST /auth/password/reset-request request (public)."""

    email: str

    @field_validator("email")
    @classmethod
    def normalize_email_value(cls, value: str) -> str:
        return normalize_email(value)


class PasswordResetConfirmRequest(BaseModel):
    """POST /auth/password/reset request (public, uses reset token)."""

    reset_token: str = Field(..., min_length=10)
    new_password: str = Field(..., min_length=1, max_length=128)


class PhoneBindRequest(BaseModel):
    """PUT /auth/phone request."""

    phone: str


class DeviceInfo(BaseModel):
    """Optional device metadata sent by the frontend on login.
    The backend derives device_id from request headers; this payload
    enriches the user_device record for human-readable management.
    """

    device_type: Optional[str] = None  # desktop | mobile | tablet
    device_name: Optional[str] = None  # "MacBook Pro" / "iPhone 15"
    os: Optional[str] = None  # parsed from user-agent or platform
    os_version: Optional[str] = None
    browser: Optional[str] = None
    browser_version: Optional[str] = None


class LoginRequest(BaseModel):
    """POST /auth/login request — email + password login."""

    email: str
    password: str
    device: Optional[DeviceInfo] = None

    @field_validator("email")
    @classmethod
    def normalize_email_value(cls, value: str) -> str:
        return normalize_email(value)

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: str) -> str:
        if not value:
            raise ValueError("密码不能为空")
        if len(value) > 1024:
            raise ValueError("密码长度不合法")
        return value


class BilibiliBindingStatus(BaseModel):
    bound: bool = False
    valid: bool = False
    mid: Optional[int] = None
    nickname: Optional[str] = None
    avatar: Optional[str] = None
    message: str = "未绑定B站账号"


class SecurityOverviewResponse(BaseModel):
    """GET /auth/security response."""

    email: Optional[str] = None
    email_verified: bool = False
    phone: Optional[str] = None
    phone_verified: bool = False
    has_password: bool = False
    oauth_bindings: list[dict] = []
    bilibili: BilibiliBindingStatus = BilibiliBindingStatus()

    class Config:
        from_attributes = True
