"""Per-uid quiz generation/grading quota backed by Redis sliding window.

Default limits (configurable via ``app/config/default.yaml`` under
``quiz.limits``):
  - generate: 5 per day per uid
  - grade: 20 per day per uid

When Redis is unavailable, the quota check is skipped (fail-open) so that
quiz functionality degrades gracefully rather than hard-failing.
"""

from __future__ import annotations

from datetime import datetime, timezone

from loguru import logger

from app.infra.config import config
from app.infra.redis import client as _redis, k

_DEFAULT_LIMITS = {"generate": 5, "grade": 20}


class QuizQuotaExceeded(Exception):
    """Raised when a uid has exhausted its daily quiz quota."""

    def __init__(self, kind: str, limit: int) -> None:
        self.kind = kind
        self.limit = limit
        super().__init__(f"quiz {kind} quota exceeded ({limit}/day)")


def _daily_limit(kind: str) -> int:
    limits = config.quiz.limits
    return int(getattr(limits, kind, _DEFAULT_LIMITS.get(kind, 0)))


def _bucket_key(uid: int, kind: str) -> str:
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    return k("quiz_quota", kind, str(uid), today)


async def check_and_consume(uid: int, kind: str) -> None:
    """Increment the daily counter for ``uid``/``kind``; raise if over limit.

    Fail-open when Redis is unavailable.
    """
    if _redis is None:
        return
    key = _bucket_key(uid, kind)
    try:
        count = await _redis.incr(key)
        if count == 1:
            await _redis.expire(key, 86400)
        limit = _daily_limit(kind)
        if count > limit:
            logger.warning(
                f"[QUIZ_QUOTA] uid={uid} kind={kind} count={count} > limit={limit}"
            )
            raise QuizQuotaExceeded(kind, limit)
    except QuizQuotaExceeded:
        raise
    except Exception as e:
        logger.warning(f"[QUIZ_QUOTA] check failed (fail-open): {e}")
