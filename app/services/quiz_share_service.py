"""Quiz sharing service — issue / revoke / read shared quiz sets.

Layering:
- Service orchestrates token generation, ownership checks, cross-store
  reads (MySQL metadata + MongoDB questions), and Redis L2 cache.
- Repository (QuizRepository) owns all SQL.
- Router is a thin delegate.

Caching strategy:
- Public read path (``get_shared_quiz``) is backed by a 60s Redis cache
  keyed by ``quiz_share:{share_token}``. Redis miss falls back to MySQL +
  MongoDB and writes back.
- ``revoke_share`` and ``create_share`` actively delete the old token's
  cache entry so revocation takes effect immediately at the L2 layer.
- nginx and the browser also cache for 60s (set in the router) — worst-case
  staleness after revocation is bounded by that TTL, which is acceptable for
  non-sensitive quiz content.

Security notes:
- ``share_token`` is a 16-byte ``secrets.token_urlsafe`` string (≈22 chars),
  decoupled from ``quiz_uuid`` so that the public endpoint cannot be enumerated
  by guessing UUID4s.
- Public read path returns questions WITHOUT correct answers / explanations /
  keywords — viewers get the quiz for self-testing only.
- Expired / revoked / invalid tokens all return the same 404 to prevent
  token-state enumeration.
"""

from __future__ import annotations

import json
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import HTTPException
from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.repository.quiz_repository import get_quiz_repository


_CACHE_TTL = 60  # seconds — keep short to bound staleness after revocation


def _generate_share_token() -> str:
    """Return a URL-safe random token with ~122 bits of entropy."""
    return secrets.token_urlsafe(16)


def _is_expired(expires_at: Optional[datetime]) -> bool:
    """True if ``expires_at`` is set and in the past."""
    if expires_at is None:
        return False
    # Stored datetimes may be tz-naive (MySQL) or tz-aware (SQLite). Normalise.
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at < datetime.now(timezone.utc)


def _cache_key(share_token: str) -> str:
    """Build the Redis cache key for a share token."""
    from app.infra.redis import k
    return k("quiz_share", share_token)


async def _invalidate_cache(share_token: Optional[str]) -> None:
    """Delete the Redis cache entry for a token. No-op if token is None
    or Redis is unavailable.
    """
    if not share_token:
        return
    try:
        from app.infra.redis import client as _redis
        if _redis:
            await _redis.delete(_cache_key(share_token))
    except Exception as e:
        logger.warning(f"[QUIZ_SHARE] cache invalidation failed: {e}")


class QuizShareService:
    """Orchestrates quiz sharing lifecycle."""

    async def create_share(
        self,
        quiz_uuid: str,
        uid: int,
        db: AsyncSession,
        expires_in_days: Optional[int] = None,
    ) -> dict[str, Any]:
        """Create or rotate the share_token for an owned quiz.

        Returns ``{"quiz_uuid", "share_token", "shared_at", "share_expires_at"}``.
        Raises 404 if the quiz does not exist or is not owned by ``uid``.
        Raises 400 if the quiz is not in a shareable state.
        ``expires_in_days``: None = never expires; otherwise must be 1..365.
        """
        if expires_in_days is not None and not (1 <= expires_in_days <= 365):
            raise HTTPException(status_code=400, detail="有效期必须在 1~365 天之间")

        repo = get_quiz_repository()
        qs = await repo.get_owned_quiz(quiz_uuid, uid, db)
        if qs is None:
            raise HTTPException(status_code=404, detail="题目集不存在")
        if qs.status != "done":
            raise HTTPException(
                status_code=400, detail="题目尚未生成完成，无法分享"
            )

        token = _generate_share_token()
        expires_at: Optional[datetime] = (
            datetime.now(timezone.utc) + timedelta(days=expires_in_days)
            if expires_in_days is not None
            else None
        )
        ok, previous_token = await repo.set_share_token(
            quiz_uuid, uid, token, db, expires_at
        )
        if not ok:
            raise HTTPException(status_code=404, detail="题目集不存在")

        # Invalidate the previous token's cache entry so the old link stops
        # serving immediately at the L2 layer (nginx/browser TTL still apply).
        await _invalidate_cache(previous_token)

        logger.info(
            f"[QUIZ_SHARE] created quiz_uuid={quiz_uuid} uid={uid} "
            f"expires_in_days={expires_in_days}"
        )
        return {
            "quiz_uuid": quiz_uuid,
            "share_token": token,
            "shared_at": qs.shared_at.isoformat() if qs.shared_at else None,
            "share_expires_at": qs.share_expires_at.isoformat()
            if qs.share_expires_at
            else None,
        }

    async def revoke_share(
        self, quiz_uuid: str, uid: int, db: AsyncSession
    ) -> dict[str, Any]:
        """Revoke sharing for an owned quiz. Idempotent."""
        repo = get_quiz_repository()
        ok, previous_token = await repo.clear_share_token(quiz_uuid, uid, db)
        if not ok:
            raise HTTPException(status_code=404, detail="题目集不存在")
        await _invalidate_cache(previous_token)
        logger.info(f"[QUIZ_SHARE] revoked quiz_uuid={quiz_uuid} uid={uid}")
        return {"quiz_uuid": quiz_uuid, "shared": False}

    async def get_share_status(
        self, quiz_uuid: str, uid: int, db: AsyncSession
    ) -> dict[str, Any]:
        """Owner-side query: is this quiz currently shared, and until when?

        Raises 404 if the quiz does not exist or is not owned by ``uid``.
        Not cached — owner-facing, low QPS.
        """
        repo = get_quiz_repository()
        qs = await repo.get_owned_quiz(quiz_uuid, uid, db)
        if qs is None:
            raise HTTPException(status_code=404, detail="题目集不存在")
        if not qs.share_token:
            return {"quiz_uuid": quiz_uuid, "shared": False}
        return {
            "quiz_uuid": quiz_uuid,
            "shared": True,
            "share_token": qs.share_token,
            "shared_at": qs.shared_at.isoformat() if qs.shared_at else None,
            "share_expires_at": qs.share_expires_at.isoformat()
            if qs.share_expires_at
            else None,
            "expired": _is_expired(qs.share_expires_at),
        }

    async def get_shared_quiz(
        self, share_token: str, db: AsyncSession
    ) -> dict[str, Any]:
        """Public read: return shared quiz WITHOUT answers.

        Served from Redis L2 cache on hit; on miss, reads MySQL + MongoDB
        and writes back with a 60s TTL.

        Raises 404 if the token is invalid, revoked, expired, or the quiz is
        not in a shareable state. The 404 is identical in all cases to prevent
        token-state enumeration. 404s are NOT cached (the caller — nginx —
        caches them briefly to absorb token-guessing).
        """
        # ── L2 read ──────────────────────────────────────────────────
        try:
            from app.infra.redis import client as _redis, jget
            if _redis:
                cached = await jget(_cache_key(share_token))
                if cached is not None:
                    return cached
        except Exception as e:
            logger.warning(f"[QUIZ_SHARE] cache read failed, falling through: {e}")

        # ── Cache miss → build payload ──────────────────────────────
        payload = await self._build_shared_quiz_payload(share_token, db)

        # ── L2 write-back (best-effort) ─────────────────────────────
        try:
            from app.infra.redis import jset
            if _redis:
                await jset(_cache_key(share_token), payload, ex=_CACHE_TTL)
        except Exception as e:
            logger.warning(f"[QUIZ_SHARE] cache write-back failed: {e}")

        return payload

    async def _build_shared_quiz_payload(
        self, share_token: str, db: AsyncSession
    ) -> dict[str, Any]:
        """Build the public quiz payload from MySQL + MongoDB.

        Raises 404 for invalid / revoked / expired / empty tokens.
        """
        repo = get_quiz_repository()
        qs = await repo.get_by_share_token(share_token, db)
        if qs is None or qs.status != "done" or _is_expired(qs.share_expires_at):
            raise HTTPException(status_code=404, detail="分享链接无效或已失效")

        # MongoDB read — questions only (no answers/explanation/keywords).
        from app.services.quiz_generator import get_quiz_questions

        questions = await get_quiz_questions(qs.quiz_uuid)
        if not questions:
            logger.warning(
                f"[QUIZ_SHARE] share_token has no questions in MongoDB "
                f"quiz_uuid={qs.quiz_uuid}"
            )
            raise HTTPException(status_code=404, detail="分享链接无效或已失效")

        return {
            "quiz_uuid": qs.quiz_uuid,
            "title": qs.title,
            "question_count": qs.question_count,
            "type_distribution": qs.type_distribution,
            "difficulty": qs.difficulty,
            "total_score": qs.total_score,
            "passing_score": qs.passing_score,
            "source_type": getattr(qs, "source_type", "folder") or "folder",
            "shared_at": qs.shared_at.isoformat() if qs.shared_at else None,
            "share_expires_at": qs.share_expires_at.isoformat()
            if qs.share_expires_at
            else None,
            "questions": [
                {
                    "question_uuid": q.get("question_uuid"),
                    "question_type": q.get("question_type"),
                    "difficulty": q.get("difficulty"),
                    "question_text": q.get("question_text"),
                    "options": _parse_json_field(q.get("options")),
                }
                for q in questions
            ],
        }


def _parse_json_field(value: Any) -> Any:
    """Parse a JSON-encoded string field, fall back to raw value."""
    if value is None:
        return None
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return value


# Module-level singleton — stateless service.
_service: Optional[QuizShareService] = None


def get_quiz_share_service() -> QuizShareService:
    global _service
    if _service is None:
        _service = QuizShareService()
    return _service
