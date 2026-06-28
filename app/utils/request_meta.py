"""Request metadata helpers — shared between routers and middleware.

Extracted from app/routers/auth.py to avoid circular imports between
the router and rate-limit deps.
"""
from __future__ import annotations

import hashlib
from typing import Any, Optional

from fastapi import Request
from ua_parser import parse as _parse_ua


def get_device_id(request: Request) -> str:
    """Derive a stable anonymous device fingerprint from request headers."""
    ua = request.headers.get("user-agent", "")
    accept_lang = request.headers.get("accept-language", "")
    raw = f"{ua}|{accept_lang}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


_GENERIC_DEVICE_FAMILIES = {"Other", "Spider", "Desktop", ""}


def extract_device_meta(request: Request) -> dict[str, Any]:
    """Parse User-Agent into structured device metadata for user_device table."""
    ua = request.headers.get("user-agent", "")
    if not ua:
        return {
            "device_type": None,
            "device_name": None,
            "os": None,
            "os_version": None,
            "browser": None,
            "browser_version": None,
        }

    parsed = _parse_ua(ua)
    os_family = parsed.os.family if parsed.os else None
    os_major = parsed.os.major if parsed.os else None
    os_minor = parsed.os.minor if parsed.os else None
    os_version = (
        f"{os_major}.{os_minor}" if os_major and os_minor else os_major
    )

    ua_family = parsed.user_agent.family if parsed.user_agent else None
    ua_major = parsed.user_agent.major if parsed.user_agent else None
    ua_minor = parsed.user_agent.minor if parsed.user_agent else None
    browser_version = (
        f"{ua_major}.{ua_minor}" if ua_major and ua_minor else ua_major
    )

    device_family = parsed.device.family if parsed.device else None

    device_type: Optional[str] = None
    if device_family and "iPhone" in device_family:
        device_type = "mobile"
    elif device_family and "iPad" in device_family:
        device_type = "tablet"
    elif device_family and "Android" in device_family:
        device_type = "mobile"
    elif device_family and "Mobile" in device_family:
        device_type = "mobile"
    elif device_family and "Tablet" in device_family:
        device_type = "tablet"

    if device_type is None:
        ua_lower = ua.lower()
        if "mobile" in ua_lower or "android" in ua_lower:
            device_type = "mobile"
        elif "ipad" in ua_lower:
            device_type = "tablet"
        else:
            device_type = "desktop"

    device_name: Optional[str] = None
    if device_family and device_family not in _GENERIC_DEVICE_FAMILIES:
        device_name = device_family

    return {
        "device_type": device_type,
        "device_name": device_name,
        "os": os_family,
        "os_version": os_version,
        "browser": ua_family,
        "browser_version": browser_version,
    }


def get_client_ip(request: Request) -> str:
    """Extract real client IP, respecting reverse-proxy headers."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    return request.client.host if request.client else "unknown"
