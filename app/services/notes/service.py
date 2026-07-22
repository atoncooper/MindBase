"""Notes service — coordinates MySQL metadata + MongoDB content.

Storage split:
  - MySQL ``notes`` row: uuid, uid, title, target_*, content_doc_id, hash, ...
  - MongoDB ``note_documents`` doc: { note_uuid, content_md, ... }

Revision snapshots are written on a coarse policy to avoid unbounded
growth: a snapshot is taken when (a) >= 10 min since last revision AND
content changed, (b) content diff > 30%, or (c) caller flags force=True
(e.g. manual Ctrl+S).
"""

from __future__ import annotations

import secrets
import uuid as _uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.repository import mongo_note_repository as mongo_note
from app.repository.note_repository import NoteRepository, get_note_repository
from app.services.notes.markdown import sanitize_markdown

# Revision policy thresholds
_REVISION_MIN_INTERVAL = timedelta(minutes=10)
_REVISION_DIFF_RATIO = 0.30
_MAX_CONTENT_BYTES = 256 * 1024  # 256 KB cap


class NoteNotFoundError(Exception):
    pass


class NotePermissionError(Exception):
    pass


class NoteConflictError(Exception):
    """Optimistic-lock conflict — note was modified by another tab/owner."""

    def __init__(self, note_uuid: str, server_updated_at: datetime):
        self.note_uuid = note_uuid
        self.server_updated_at = server_updated_at


class NoteService:
    def __init__(self, repo: Optional[NoteRepository] = None) -> None:
        self._repo = repo or get_note_repository()

    # ── Create ─────────────────────────────────────────────────────

    async def create_note(
        self,
        db: AsyncSession,
        *,
        uid: int,
        title: str,
        target_type: str,
        target_id: str,
        content_md: str = "",
    ) -> dict:
        """Create note: write Mongo content first, then MySQL metadata.

        If MySQL write fails, the Mongo doc becomes an orphan — caller
        should run the periodic orphan cleanup (future task). For now we
        log loudly and propagate the error.
        """
        if target_type not in ("video", "cloud_file"):
            raise ValueError(f"invalid target_type: {target_type}")
        if len(content_md.encode("utf-8")) > _MAX_CONTENT_BYTES:
            raise ValueError("content_md exceeds 256 KB cap")

        clean_md = sanitize_markdown(content_md)
        note_uuid = str(_uuid.uuid4())

        doc_id = await mongo_note.upsert_content(note_uuid, uid, clean_md)
        content_hash = mongo_note.content_hash(clean_md)

        try:
            await self._repo.create_note(
                db,
                uuid=note_uuid,
                uid=uid,
                title=title or "无标题",
                target_type=target_type,
                target_id=target_id,
                content_doc_id=doc_id,
                content_length=len(clean_md),
                content_hash=content_hash,
            )
        except Exception:
            # Orphan Mongo doc — log and propagate. Cleanup is async.
            logger.exception(
                f"[NOTES] MySQL write failed; orphan Mongo doc note_uuid={note_uuid}"
            )
            await mongo_note.delete_content(note_uuid)
            raise

        return await self.get_note(db, note_uuid, uid=uid)

    # ── Read ───────────────────────────────────────────────────────

    async def get_note(
        self,
        db: AsyncSession,
        note_uuid: str,
        *,
        uid: int,
    ) -> dict:
        """Fetch note detail (metadata + content + anchors)."""
        note = await self._repo.get_by_uuid(db, note_uuid)
        if note is None:
            raise NoteNotFoundError(note_uuid)
        if note.uid != uid:
            # Treat not-owned as 404 to avoid leaking existence.
            raise NoteNotFoundError(note_uuid)

        content_doc = await mongo_note.get_content(note_uuid)
        content_md = content_doc.get("content_md", "") if content_doc else ""

        anchors = await self._repo.list_anchors(db, note.id)
        share = await self._repo.get_active_share_for_note(db, note_uuid)

        return {
            **self._meta_to_dict(note),
            "content_md": content_md,
            "anchors": [self._anchor_to_dict(a) for a in anchors],
            "share_token": share.share_token if share else None,
            "share_expires_at": share.expires_at if share else None,
        }

    async def list_notes(
        self,
        db: AsyncSession,
        uid: int,
        *,
        target_type: Optional[str] = None,
        target_id: Optional[str] = None,
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[dict], int]:
        notes, total = await self._repo.list_by_user(
            db,
            uid,
            target_type=target_type,
            target_id=target_id,
            page=page,
            page_size=page_size,
        )
        return [self._meta_to_dict(n) for n in notes], total

    # ── Update ─────────────────────────────────────────────────────

    async def update_note(
        self,
        db: AsyncSession,
        note_uuid: str,
        *,
        uid: int,
        title: Optional[str] = None,
        content_md: Optional[str] = None,
        is_pinned: Optional[bool] = None,
        if_match: Optional[datetime] = None,
    ) -> dict:
        """Update note. Content hash short-circuits no-op writes.

        ``if_match`` is the client's last-seen ``updated_at``; if it does
        not equal the server's current value, raises ``NoteConflictError``
        (caller returns 409).

        Single-commit semantics: all field changes (content + title +
        is_pinned) are applied in one ``update_meta`` call so the row is
        never left in a half-applied state and ``updated_at`` advances
        by exactly one tick per request.
        """
        note = await self._repo.get_by_uuid(db, note_uuid)
        if note is None:
            raise NoteNotFoundError(note_uuid)
        if note.uid != uid:
            raise NoteNotFoundError(note_uuid)

        if if_match is not None and if_match != note.updated_at:
            raise NoteConflictError(note_uuid, note.updated_at)

        # Reject no-op updates so silent field-mapping regressions surface
        # as 400 instead of a misleading 200.
        if title is None and content_md is None and is_pinned is None:
            raise ValueError("empty update: at least one field required")

        new_title: Optional[str] = title
        new_pinned: Optional[bool] = is_pinned
        new_length: Optional[int] = None
        new_hash: Optional[str] = None
        bump_revision = False

        if content_md is not None:
            if len(content_md.encode("utf-8")) > _MAX_CONTENT_BYTES:
                raise ValueError("content_md exceeds 256 KB cap")
            clean_md = sanitize_markdown(content_md)
            computed_hash = mongo_note.content_hash(clean_md)
            if computed_hash != note.content_hash:
                # Capture OLD content BEFORE upsert — _should_snapshot
                # needs the pre-update body to compute a real diff.
                old_doc = await mongo_note.get_content(note_uuid)
                old_md = old_doc.get("content_md", "") if old_doc else ""

                await mongo_note.upsert_content(note_uuid, uid, clean_md)
                bump_revision = await self._should_snapshot(
                    note_uuid, old_md, clean_md
                )
                new_length = len(clean_md)
                new_hash = computed_hash
                if bump_revision:
                    await mongo_note.insert_revision(
                        note_uuid, clean_md, revision_note="auto-snapshot"
                    )

        # Single commit for all field changes.
        if (
            new_title is not None
            or new_pinned is not None
            or new_length is not None
            or new_hash is not None
        ):
            await self._repo.update_meta(
                db,
                note,
                title=new_title,
                is_pinned=new_pinned,
                content_length=new_length,
                content_hash=new_hash,
                bump_revision=bump_revision,
            )

        # Return full detail (meta + content_md + anchors + share) so the
        # NoteDetailResponse validation passes - returning _meta_to_dict alone
        # omits content_md and triggers a 500 that breaks the auto-save loop
        # (serverUpdatedAtRef never advances -> next save 409s).
        return await self.get_note(db, note_uuid, uid=uid)

    @staticmethod
    async def _should_snapshot(
        note_uuid: str,
        old_content: str,
        new_content: str,
    ) -> bool:
        """Decide whether to write a revision snapshot for this update.

        Policy:
          - Empty new content → never snapshot.
          - No prior revision + non-trivial new content → snapshot.
          - Last revision < 10 min ago → skip (avoid churn).
          - Otherwise snapshot if diff ratio >= 30%.

        ``old_content`` MUST be captured by the caller BEFORE the upsert.
        """
        if not new_content:
            return False
        if not old_content:
            return True

        revisions = await mongo_note.list_revisions(note_uuid, limit=1)
        if revisions:
            last_rev_at = revisions[0].get("created_at")
            if last_rev_at is not None:
                now = datetime.now(timezone.utc)
                if last_rev_at.tzinfo is None:
                    last_rev_at = last_rev_at.replace(tzinfo=timezone.utc)
                if now - last_rev_at < _REVISION_MIN_INTERVAL:
                    return False

        diff_ratio = NoteService._diff_ratio(old_content, new_content)
        return diff_ratio >= _REVISION_DIFF_RATIO

    @staticmethod
    def _diff_ratio(a: str, b: str) -> float:
        """Cheap character-level diff ratio (Levenshtein-free).

        Uses length delta + position-sample; good enough for the snapshot
        trigger heuristic.
        """
        if not a and not b:
            return 0.0
        max_len = max(len(a), len(b))
        if max_len == 0:
            return 0.0
        # Quick path: length differs significantly.
        len_diff = abs(len(a) - len(b))
        if len_diff / max_len >= _REVISION_DIFF_RATIO:
            return len_diff / max_len
        # Sample-based: count differing chars at same positions.
        min_len = min(len(a), len(b))
        diffs = sum(1 for i in range(min_len) if a[i] != b[i])
        diffs += len_diff
        return diffs / max_len

    # ── Delete ─────────────────────────────────────────────────────

    async def delete_note(
        self, db: AsyncSession, note_uuid: str, *, uid: int
    ) -> None:
        """Soft-delete note (MySQL) and hard-delete Mongo content.

        Revisions are preserved so users can restore from history if the
        note is un-deleted in the future.
        """
        note = await self._repo.get_by_uuid(db, note_uuid, include_deleted=True)
        if note is None:
            raise NoteNotFoundError(note_uuid)
        if note.uid != uid:
            raise NoteNotFoundError(note_uuid)
        await self._repo.soft_delete(db, note)
        await self._repo.revoke_shares(db, note_uuid)
        # Hard-delete current content doc so it's not readable; revisions
        # are kept for potential future restore.
        await mongo_note.delete_content(note_uuid)
        logger.info(f"[NOTES] soft-deleted note_uuid={note_uuid} uid={uid}")

    # ── Anchors ────────────────────────────────────────────────────

    async def add_anchor(
        self,
        db: AsyncSession,
        note_uuid: str,
        *,
        uid: int,
        block_id: str,
        position: int,
        label: Optional[str],
    ) -> dict:
        note = await self._repo.get_by_uuid(db, note_uuid)
        if note is None or note.uid != uid:
            raise NoteNotFoundError(note_uuid)
        anchor = await self._repo.add_anchor(
            db, note.id, block_id, position, label
        )
        return self._anchor_to_dict(anchor)

    async def delete_anchor(
        self, db: AsyncSession, note_uuid: str, anchor_id: int, *, uid: int
    ) -> None:
        note = await self._repo.get_by_uuid(db, note_uuid)
        if note is None or note.uid != uid:
            raise NoteNotFoundError(note_uuid)
        deleted = await self._repo.delete_anchor(db, note.id, anchor_id)
        if not deleted:
            raise NoteNotFoundError(f"anchor {anchor_id}")

    # ── Sharing ────────────────────────────────────────────────────

    async def create_share(
        self,
        db: AsyncSession,
        note_uuid: str,
        *,
        uid: int,
        expires_in_days: Optional[int] = None,
    ) -> dict:
        note = await self._repo.get_by_uuid(db, note_uuid)
        if note is None or note.uid != uid:
            raise NoteNotFoundError(note_uuid)

        # Revoke any prior active shares (one active share at a time).
        await self._repo.revoke_shares(db, note_uuid)

        token = secrets.token_urlsafe(32)
        expires_at = None
        if expires_in_days is not None:
            expires_at = datetime.now(timezone.utc) + timedelta(days=expires_in_days)

        share = await self._repo.create_share(
            db,
            note_uuid=note_uuid,
            share_token=token,
            created_by_uid=uid,
            expires_at=expires_at,
        )
        return {
            "share_token": share.share_token,
            "share_url": f"/notes/shared/{share.share_token}",
            "expires_at": share.expires_at,
        }

    async def revoke_share(
        self, db: AsyncSession, note_uuid: str, *, uid: int
    ) -> None:
        note = await self._repo.get_by_uuid(db, note_uuid)
        if note is None or note.uid != uid:
            raise NoteNotFoundError(note_uuid)
        await self._repo.revoke_shares(db, note_uuid)

    async def get_shared_view(
        self, db: AsyncSession, share_token: str
    ) -> dict:
        """Public read-only view — no auth required."""
        share = await self._repo.get_active_share_by_token(db, share_token)
        if share is None:
            raise NoteNotFoundError("share")

        note = await self._repo.get_by_uuid(
            db, share.note_uuid, include_deleted=False
        )
        if note is None:
            raise NoteNotFoundError("note")

        content_doc = await mongo_note.get_content(note.uuid)
        content_md = content_doc.get("content_md", "") if content_doc else ""

        await self._repo.increment_view_count(db, share)

        return {
            "title": note.title,
            "content_md": content_md,
            "target_type": note.target_type,
            "target_id": note.target_id,
            "shared_at": share.created_at,
            "view_count": share.view_count,
        }

    # ── Revisions ──────────────────────────────────────────────────

    async def list_revisions(
        self, db: AsyncSession, note_uuid: str, *, uid: int
    ) -> list[dict]:
        note = await self._repo.get_by_uuid(db, note_uuid)
        if note is None or note.uid != uid:
            raise NoteNotFoundError(note_uuid)
        return await mongo_note.list_revisions(note_uuid)

    async def restore_revision(
        self,
        db: AsyncSession,
        note_uuid: str,
        revision_id: str,
        *,
        uid: int,
    ) -> dict:
        note = await self._repo.get_by_uuid(db, note_uuid)
        if note is None or note.uid != uid:
            raise NoteNotFoundError(note_uuid)

        rev = await mongo_note.get_revision(revision_id)
        if rev is None or rev.get("note_uuid") != note_uuid:
            raise NoteNotFoundError(f"revision {revision_id}")

        clean_md = sanitize_markdown(rev.get("content_md", ""))
        await mongo_note.upsert_content(note_uuid, uid, clean_md)
        new_hash = mongo_note.content_hash(clean_md)
        await self._repo.update_meta(
            db,
            note,
            content_length=len(clean_md),
            content_hash=new_hash,
            bump_revision=True,
        )
        await mongo_note.insert_revision(
            note_uuid, clean_md, revision_note=f"restored from {revision_id}"
        )
        return self._meta_to_dict(note)

    # ── Serialisation ─────────────────────────────────────────────

    @staticmethod
    def _meta_to_dict(note) -> dict:
        return {
            "uuid": note.uuid,
            "title": note.title,
            "target_type": note.target_type,
            "target_id": note.target_id,
            "content_length": note.content_length or 0,
            "is_pinned": bool(note.is_pinned),
            "revision_count": note.revision_count or 0,
            "created_at": note.created_at,
            "updated_at": note.updated_at,
        }

    @staticmethod
    def _anchor_to_dict(anchor) -> dict:
        return {
            "id": anchor.id,
            "block_id": anchor.block_id,
            "position": anchor.position,
            "label": anchor.label,
            "created_at": anchor.created_at,
        }


# ── Module-level singleton ─────────────────────────────────────────


_service: Optional[NoteService] = None


def get_note_service() -> NoteService:
    global _service
    if _service is None:
        _service = NoteService()
    return _service
