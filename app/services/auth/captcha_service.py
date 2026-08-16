"""Graphical captcha — anti-bot gate for sensitive auth endpoints.

Self-hosted (no third-party service): Pillow renders a distorted-character
PNG, the answer is stored in Redis as a SHA-256 digest, and verification is
an atomic compare-and-delete so every captcha is single-use — consumed on
success *and* failure, forcing a fresh image per attempt.

Degradation: when Redis is unavailable (disabled in config or down) the
gate fails open, mirroring rate_limit_service. ``generate()`` signals this
via ``required=False`` so the frontend hides the input; ``verify()``
likewise allows requests without captcha fields. The layered rate limits
remain the backstop in that state.
"""

from __future__ import annotations

import base64
import hashlib
import io
import random
import secrets
from dataclasses import dataclass

from loguru import logger
from PIL import Image, ImageDraw, ImageFont

from app.config import settings
from app.infra import redis as redis_mod

# Uppercase + digits minus visually confusable characters (I O L 0 1).
_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

@dataclass(frozen=True)
class CaptchaResult:
    captcha_id: str
    image_data_url: str  # "data:image/png;base64,..." — direct <img src>
    expires_in: int  # seconds; 0 when degraded
    required: bool  # False → captcha gate bypassed (feature off / Redis down)


def _digest(code: str) -> bytes:
    return hashlib.sha256(code.strip().lower().encode()).hexdigest().encode()


def _captcha_key(captcha_id: str) -> str:
    return redis_mod.k("auth", "captcha", captcha_id)


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    try:
        return ImageFont.load_default(size=size)  # Pillow >= 10.1
    except TypeError:
        return ImageFont.load_default()


def _random_color(start: int, end: int) -> tuple[int, int, int]:
    return tuple(random.randint(start, end) for _ in range(3))


def _render_code(code: str, width: int, height: int) -> bytes:
    """Render *code* as a PNG with per-char rotation, noise lines and dots."""
    img = Image.new("RGB", (width, height), _random_color(235, 250))
    draw = ImageDraw.Draw(img)
    font = _load_font(int(height * 0.62))

    slot = width / len(code)
    for i, ch in enumerate(code):
        tile_side = int(height * 0.95)
        tile = Image.new("RGBA", (tile_side, tile_side), (0, 0, 0, 0))
        ImageDraw.Draw(tile).text(
            (tile_side // 8, tile_side // 8),
            ch,
            font=font,
            fill=_random_color(20, 110),
        )
        tile = tile.rotate(
            random.uniform(-28, 28), expand=True, resample=Image.BICUBIC
        )
        x = int(slot * i + random.uniform(2, max(2.0, slot - tile.width)))
        y = random.randint(-4, max(-4, height - tile.height + 4))
        img.paste(tile, (x, y), tile)

    for _ in range(4):
        draw.line(
            [
                (random.randint(0, width), random.randint(0, height)),
                (random.randint(0, width), random.randint(0, height)),
            ],
            fill=_random_color(120, 200),
            width=random.randint(1, 2),
        )
    for _ in range(width * height // 40):
        draw.point(
            (random.randint(0, width - 1), random.randint(0, height - 1)),
            fill=_random_color(60, 200),
        )

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


async def generate_captcha() -> CaptchaResult:
    """Create a fresh captcha. Returns ``required=False`` when degraded."""
    if not settings.captcha_enabled or not redis_mod.is_enabled():
        return CaptchaResult(captcha_id="", image_data_url="", expires_in=0, required=False)

    code = "".join(secrets.choice(_CHARSET) for _ in range(settings.captcha_length))
    captcha_id = secrets.token_urlsafe(16)
    ttl = settings.captcha_ttl_seconds
    png = _render_code(
        code,
        width=settings.captcha_image_width,
        height=settings.captcha_image_height,
    )

    try:
        assert redis_mod.client is not None
        await redis_mod.client.set(_captcha_key(captcha_id), _digest(code), ex=ttl)
    except Exception as e:
        logger.warning("[CAPTCHA] redis write failed, serving degraded response err={}", e)
        return CaptchaResult(captcha_id="", image_data_url="", expires_in=0, required=False)

    b64 = base64.b64encode(png).decode()
    logger.debug("[CAPTCHA] generated ttl={}s", ttl)
    return CaptchaResult(
        captcha_id=captcha_id,
        image_data_url=f"data:image/png;base64,{b64}",
        expires_in=ttl,
        required=True,
    )


async def verify_captcha(captcha_id: str | None, code: str | None) -> bool:
    """Atomically consume and check a captcha. Single-use: calling this
    twice with the same id fails the second time regardless of outcome."""
    if not settings.captcha_enabled:
        return True
    if not redis_mod.is_enabled():
        logger.debug("[CAPTCHA] redis disabled, allowing")
        return True
    if not captcha_id or not code:
        return False
    try:
        if await redis_mod.cas_delete(_captcha_key(captcha_id), _digest(code)):
            return True
        # Consume on failure too — every verification attempt burns the
        # captcha, closing the brute-force-the-code window.
        assert redis_mod.client is not None
        await redis_mod.client.delete(_captcha_key(captcha_id))
        return False
    except Exception as e:
        logger.warning("[CAPTCHA] redis error, fail-open err={}", e)
        return True
