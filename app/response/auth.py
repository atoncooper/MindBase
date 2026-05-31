"""
Pydantic schemas for auth API — request / response models.
"""

from datetime import datetime, date
from typing import Optional
from pydantic import BaseModel


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
    password: str


class PasswordChangeRequest(BaseModel):
    """PATCH /auth/password request."""
    old_password: str
    new_password: str


class EmailBindRequest(BaseModel):
    """PUT /auth/email request."""
    email: str


class PhoneBindRequest(BaseModel):
    """PUT /auth/phone request."""
    phone: str


class DeviceInfo(BaseModel):
    """Optional device metadata sent by the frontend on login.
    The backend derives device_id from request headers; this payload
    enriches the user_device record for human-readable management.
    """
    device_type: Optional[str] = None         # desktop | mobile | tablet
    device_name: Optional[str] = None         # "MacBook Pro" / "iPhone 15"
    os: Optional[str] = None                  # parsed from user-agent or platform
    os_version: Optional[str] = None
    browser: Optional[str] = None
    browser_version: Optional[str] = None


class LoginRequest(BaseModel):
    """POST /auth/login request — email + password login."""
    email: str
    password: str
    device: Optional[DeviceInfo] = None


class SecurityOverviewResponse(BaseModel):
    """GET /auth/security response."""
    email: Optional[str] = None
    email_verified: bool = False
    phone: Optional[str] = None
    phone_verified: bool = False
    has_password: bool = False
    oauth_bindings: list[dict] = []

    class Config:
        from_attributes = True
