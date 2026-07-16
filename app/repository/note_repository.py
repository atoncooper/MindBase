"""MySQL repository for note metadata (notes / note_anchors / note_shares).

Content lives in MongoDB; this repository only handles structured metadata
for list / filter / permission checks.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, update, delete, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Note, NoteAnchor, NoteShare


class NoteRepository:
    """Data access for notes / note_anchors / note_shares."""

    # ── Notes ──────────────────────────────────────────────────────

    async def create_note(
        self,
        db: AsyncSession,
        *,
        uuid: str,
        uid: int,
        title: str,
        target_type: str,
        target_id: str,
        content_doc_id: str,
        content_length: int,
        content_hash: Optional[str],
    ) -> Note:
        note = Note(
            uuid=uuid,
            uid=uid,
            title=title,
            target_type=target_type,
            target_id=target_id,
            content_doc_id=content_doc_id,
            content_length=content_length,
            content_hash=content_hash,
        )
        db.add(note)
        await db.commit()
        await db.refresh(note)
        return note

    async def get_by_uuid(
        self, db: AsyncSession, uuid: str, *, include_deleted: bool = False
    ) -> Optional[Note]:
        stmt = select(Note).where(Note.uuid == uuid)
        if not include_deleted:
            stmt = stmt.where(Note.is_deleted == False)  # noqa: E712
        result = await db.execute(stmt)
        return result.scalar_one_or_none()

    async def list_by_user(
        self,
        db: AsyncSession,
        uid: int,
        *,
        target_type: Optional[str] = None,
        target_id: Optional[str] = None,
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[Note], int]:
        """Paginated list of non-deleted notes for a user.

        Returns (notes, total_count).
        """
        filters = [Note.uid == uid, Note.is_deleted == False]  # noqa: E712
        if target_type:
            filters.append(Note.target_type == target_type)
        if target_id:
            filters.append(Note.target_id == target_id)

        count_stmt = select(func.count(Note.id)).where(*filters)
        total = int((await db.execute(count_stmt)).scalar() or 0)

        list_stmt = (
            select(Note)
            .where(*filters)
            .order_by(Note.is_pinned.desc(), Note.updated_at.desc())
            .limit(page_size)
            .offset((page - 1) * page_size)
        )
        rows = (await db.execute(list_stmt)).scalars().all()
        return list(rows), total

    async def update_meta(
        self,
        db: AsyncSession,
        note: Note,
        *,
        title: Optional[str] = None,
        content_doc_id: Optional[str] = None,
        content_length: Optional[int] = None,
        content_hash: Optional[str] = None,
        is_pinned: Optional[bool] = None,
        bump_revision: bool = False,
    ) -> Note:
        if title is not None:
            note.title = title
        if content_doc_id is not None:
            note.content_doc_id = content_doc_id
        if content_length is not None:
            note.content_length = content_length
        if content_hash is not None:
            note.content_hash = content_hash
        if is_pinned is not None:
            note.is_pinned = is_pinned
        if bump_revision:
            note.revision_count = (note.revision_count or 0) + 1
        note.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(note)
        return note

    async def soft_delete(self, db: AsyncSession, note: Note) -> None:
        note.is_deleted = True
        note.updated_at = datetime.now(timezone.utc)
        await db.commit()

    # ── Anchors ────────────────────────────────────────────────────

    async def add_anchor(
        self,
        db: AsyncSession,
        note_id: int,
        block_id: str,
        position: int,
        label: Optional[str],
    ) -> NoteAnchor:
        anchor = NoteAnchor(
            note_id=note_id, block_id=block_id, position=position, label=label
        )
        db.add(anchor)
        await db.commit()
        await db.refresh(anchor)
        return anchor

    async def list_anchors(self, db: AsyncSession, note_id: int) -> list[NoteAnchor]:
        result = await db.execute(
            select(NoteAnchor)
            .where(NoteAnchor.note_id == note_id)
            .order_by(NoteAnchor.position.asc())
        )
        return list(result.scalars().all())

    async def delete_anchor(
        self, db: AsyncSession, note_id: int, anchor_id: int
    ) -> bool:
        result = await db.execute(
            delete(NoteAnchor).where(
                NoteAnchor.id == anchor_id, NoteAnchor.note_id == note_id
            )
        )
        await db.commit()
        return result.rowcount > 0

    # ── Shares ─────────────────────────────────────────────────────

    async def create_share(
        self,
        db: AsyncSession,
        *,
        note_uuid: str,
        share_token: str,
        created_by_uid: int,
        expires_at: Optional[datetime],
    ) -> NoteShare:
        share = NoteShare(
            note_uuid=note_uuid,
            share_token=share_token,
            created_by_uid=created_by_uid,
            expires_at=expires_at,
        )
        db.add(share)
        await db.commit()
        await db.refresh(share)
        return share

    async def get_active_share_by_token(
        self, db: AsyncSession, share_token: str
    ) -> Optional[NoteShare]:
        """Fetch a non-revoked, non-expired share by token."""
        result = await db.execute(
            select(NoteShare).where(
                NoteShare.share_token == share_token,
                NoteShare.is_revoked == False,  # noqa: E712
            )
        )
        share = result.scalar_one_or_none()
        if share is None:
            return None
        if share.expires_at is not None:
            if share.expires_at <= datetime.now(timezone.utc):
                return None
        return share

    async def get_active_share_for_note(
        self, db: AsyncSession, note_uuid: str
    ) -> Optional[NoteShare]:
        """Most recent active share for a note (for owner display)."""
        result = await db.execute(
            select(NoteShare)
            .where(
                NoteShare.note_uuid == note_uuid,
                NoteShare.is_revoked == False,  # noqa: E712
            )
            .order_by(NoteShare.created_at.desc())
        )
        shares = result.scalars().all()
        now = datetime.now(timezone.utc)
        for s in shares:
            if s.expires_at is None or s.expires_at > now:
                return s
        return None

    async def revoke_shares(self, db: AsyncSession, note_uuid: str) -> int:
        result = await db.execute(
            update(NoteShare)
            .where(
                NoteShare.note_uuid == note_uuid,
                NoteShare.is_revoked == False,  # noqa: E712
            )
            .values(is_revoked=True)
        )
        await db.commit()
        return result.rowcount

    async def increment_view_count(self, db: AsyncSession, share: NoteShare) -> None:
        share.view_count = (share.view_count or 0) + 1
        await db.commit()


# ── Module-level singleton ──────────────────────────────────────────


_repo: Optional[NoteRepository] = None


def get_note_repository() -> NoteRepository:
    global _repo
    if _repo is None:
        _repo = NoteRepository()
    return _repo
