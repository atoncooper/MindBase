"""Per-account login throttling — defends against password brute force.

Strategy:
- Track failed login attempts per (normalised email) in Redis with a sliding
  1-hour window.
- After MAX_FAILED_ATTEMPTS failed attempts within the window, subsequent
  attempts are rejected with HTTP 429 until LOCKOUT_TTL expires.
- A successful login clears the counter.

When Redis is unavailable, throttling fails open (no lockout) — the global
per-IP rate limiter (middleware/rate_limit.py) remains the second line of
defense; nginx is the first.
"""

from __future__ import annotations

from loguru import logger

# Tunables — deliberately conservative for a credential endpoint.
MAX_FAILED_ATTEMPTS = 5     # lockout threshold within the window
WINDOW_SECONDS = 3600       # 1 hour rolling window
LOCKOUT_SECONDS = 900       # 15 min hard lockout after threshold reached
KEY_PREFIX = "bilirag:login_fail"


def _normalise_email(email: str) -> str:
    return (email or "").strip().lower()


def _key(email: str) -> str:
    return f"{KEY_PREFIX}:{_normalise_email(email)}"


async def _get_redis():
    """Return the redis client if enabled, else None."""
    try:
        from app.infra.redis import client, is_enabled
        if is_enabled() and client is not None:
            return client
    except Exception as e:
        logger.debug("[LOGIN_THROTTLE] redis unavailable: {}", e)
    return None


async def check_login_allowed(email: str) -> tuple[bool, int | None]:
    """Return (allowed, retry_after_seconds).

    When the account is locked, returns (False, seconds_until_unlock).
    Callers should raise 429 with the retry_after value.
    """
    redis = await _get_redis()
    if redis is None:
        return True, None

    try:
        key = _key(email)
        count = await redis.get(key)
        if count is None:
            return True, None
        count = int(count)
        if count >= MAX_FAILED_ATTEMPTS:
            ttl = await redis.ttl(key)
            return False, max(ttl, 1)
        return True, None
    except Exception as e:
        logger.debug("[LOGIN_THROTTLE] check failed (fail open): {}", e)
        return True, None


async def record_failed_login(email: str) -> None:
    """Increment the failure counter; set TTL on first failure."""
    redis = await _get_redis()
    if redis is None:
        return

    try:
        key = _key(email)
        current = await redis.incr(key)
        if current == 1:
            # First failure in the window — set the rolling TTL.
            await redis.expire(key, WINDOW_SECONDS)
        elif current >= MAX_FAILED_ATTEMPTS:
            # Just crossed the threshold — extend TTL to the hard lockout
            # so the account stays locked even if the rolling window would
            # have expired sooner.
            await redis.expire(key, LOCKOUT_SECONDS)
    except Exception as e:
        logger.debug("[LOGIN_THROTTLE] record failed (fail open): {}", e)


async def record_successful_login(email: str) -> None:
    """Clear the failure counter on success."""
    redis = await _get_redis()
    if redis is None:
        return
    try:
        await redis.delete(_key(email))
    except Exception as e:
        logger.debug("[LOGIN_THROTTLE] clear failed (fail open): {}", e)
