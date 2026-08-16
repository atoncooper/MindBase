"""
Pydantic schemas for auth API — request / response models.
"""

import re
from datetime import datetime, date
from typing import Optional
from pydantic import BaseModel, Field, field_validator, model_validator


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


_PHONE_RE = re.compile(r"1[3-9]\d{9}")


def normalize_phone(value: str) -> str:
    """Normalize a mainland-China mobile number and validate its format.

    Tolerates spaces/dashes and +86 / 0086 prefixes. Raises ValueError on
    anything that isn't a valid 11-digit mainland mobile number.
    """
    phone = value.strip().replace(" ", "").replace("-", "")
    if phone.startswith("+86"):
        phone = phone[3:]
    elif phone.startswith("0086"):
        phone = phone[4:]
    if not _PHONE_RE.fullmatch(phone):
        raise ValueError("手机号格式不正确")
    return phone


class QRCodeResponse(BaseModel):
    """GET /auth/qrcode response."""

    qrcode_key: str
    qrcode_url: str
    qrcode_image_base64: str


class CaptchaResponse(BaseModel):
    """GET /auth/captcha response.

    ``required=False`` means the captcha gate is degraded (feature disabled
    or Redis unavailable): the frontend hides the captcha input and the
    backend verify() fails open.
    """

    captcha_id: str = ""
    image_base64: str = ""  # data URL, direct <img src> use
    expires_in: int = 0
    required: bool = True


class CaptchaRequestBase(BaseModel):
    """Mixin for requests gated by graphical captcha.

    Fields are Optional so a missing captcha yields a friendly 400 from the
    service layer instead of a pydantic 422, and so endpoints keep working
    when the captcha feature is disabled.
    """

    captcha_id: Optional[str] = None
    captcha_code: Optional[str] = None


class WeChatQRResponse(BaseModel):
    """GET /auth/wechat/qrcode response — wxLogin.js init params + one-time state.

    ``enabled=False`` when WeChat credentials are not configured (or Redis
    is unavailable so no state can be issued): the frontend hides the tab.
    """

    enabled: bool = False
    app_id: str = ""
    redirect_uri: str = ""
    state: str = ""


class WeChatLoginRequest(BaseModel):
    """POST /auth/wechat/login | /auth/wechat/bind request."""

    code: str
    state: str

    @field_validator("code")
    @classmethod
    def validate_code(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("授权码不能为空")
        return value.strip()

    @field_validator("state")
    @classmethod
    def validate_state(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("登录状态不能为空")
        return value.strip()


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
    """POST /auth/password/set request.

    First-time password set on an already-authenticated session. A
    verification code is REQUIRED as a second factor (mirrors change
    password): email_code when a verified email exists, sms_code when only
    a verified phone exists. Neither channel → the endpoint refuses and
    the user must bind+verify a contact first (also their recovery path).
    """

    password: str = Field(..., min_length=1, max_length=128)
    email_code: Optional[str] = None
    sms_code: Optional[str] = None


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


class EmailSendCodeRequest(CaptchaRequestBase):
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


class PasswordResetRequest(CaptchaRequestBase):
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


class LoginRequest(CaptchaRequestBase):
    """POST /auth/login request — password login with email OR phone."""

    email: Optional[str] = None
    phone: Optional[str] = None
    password: str
    device: Optional[DeviceInfo] = None

    @field_validator("email")
    @classmethod
    def normalize_email_value(cls, value: Optional[str]) -> Optional[str]:
        return normalize_email(value) if value else value

    @field_validator("phone")
    @classmethod
    def normalize_phone_value(cls, value: Optional[str]) -> Optional[str]:
        return normalize_phone(value) if value else value

    @model_validator(mode="after")
    def require_exactly_one_identifier(self) -> "LoginRequest":
        if not self.email and not self.phone:
            raise ValueError("请输入邮箱或手机号")
        if self.email and self.phone:
            raise ValueError("邮箱与手机号只能填一项")
        return self

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: str) -> str:
        if not value:
            raise ValueError("密码不能为空")
        if len(value) > 1024:
            raise ValueError("密码长度不合法")
        return value


class RegisterSendCodeRequest(CaptchaRequestBase):
    """POST /auth/register/email/send-code request (public)."""

    email: str

    @field_validator("email")
    @classmethod
    def normalize_email_value(cls, value: str) -> str:
        return normalize_email(value)


class RegisterRequest(CaptchaRequestBase):
    """POST /auth/register/email request (public)."""

    email: str
    password: str
    code: str

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

    @field_validator("code")
    @classmethod
    def validate_code(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("验证码不能为空")
        return value.strip()


class PhoneSendCodeRequest(CaptchaRequestBase):
    """POST /auth/phone/send-code request.

    purpose=login is public (registration/login); purpose=bind and
    purpose=twofa require an authenticated caller (enforced at the
    router). twofa sends a code for sensitive-operation second factor
    (e.g. first-time password set).
    """

    phone: str
    purpose: str = "login"  # login | bind | twofa

    @field_validator("phone")
    @classmethod
    def normalize_phone_value(cls, value: str) -> str:
        return normalize_phone(value)

    @field_validator("purpose")
    @classmethod
    def validate_purpose(cls, value: str) -> str:
        if value not in ("login", "bind", "twofa"):
            raise ValueError("无效的验证用途")
        return value


class PhoneLoginRequest(CaptchaRequestBase):
    """POST /auth/phone/login request (public)."""

    phone: str
    code: str

    @field_validator("phone")
    @classmethod
    def normalize_phone_value(cls, value: str) -> str:
        return normalize_phone(value)

    @field_validator("code")
    @classmethod
    def validate_code(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("验证码不能为空")
        return value.strip()


class PhoneVerifyRequest(BaseModel):
    """POST /auth/phone/verify request (authenticated)."""

    phone: str
    code: str

    @field_validator("phone")
    @classmethod
    def normalize_phone_value(cls, value: str) -> str:
        return normalize_phone(value)

    @field_validator("code")
    @classmethod
    def validate_code(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("验证码不能为空")
        return value.strip()


class FeaturesResponse(BaseModel):
    """GET /auth/features response — login/register capability flags.

    Lets the frontend hide entries for unconfigured channels (SMS etc.)
    without hardcoding deployment knowledge.
    """

    email_register_enabled: bool = False
    sms_enabled: bool = False


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
