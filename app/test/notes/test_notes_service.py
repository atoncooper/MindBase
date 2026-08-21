"""Service-layer tests for the notes feature.

The MySQL side runs against an in-memory SQLite (via the ``test_db``
fixture). The MongoDB side is monkeypatched with an in-process dict so
the tests do not require a live Mongo instance.
"""

from __future__ import annotations

import asyncio
import sys
import uuid as _uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.repository.note_repository import NoteRepository  # noqa: E402
from app.services.notes.service import (  # noqa: E402
    NoteConflictError,
    NoteNotFoundError,
    NoteService,
)


# ─── In-process Mongo stub ──────────────────────────────────────────


class _FakeMongo:
    """Replaces app.repository.mongo_note_repository functions."""

    def __init__(self) -> None:
        self.contents: dict[str, dict] = {}
        self.revisions: dict[str, list[dict]] = {}
        self._counter = 0

    async def upsert_content(
        self,
        note_uuid: str,
        uid: int,
        content_md: str,
        *,
        blocks_json: Optional[list] = None,
    ) -> str:
        self._counter += 1
        doc_id = f"docid-{note_uuid}-{self._counter}"
        now = datetime.now(timezone.utc)
        existing = self.contents.get(note_uuid)
        self.contents[note_uuid] = {
            "note_uuid": note_uuid,
            "uid": uid,
            "content_md": content_md,
            "blocks_json": blocks_json,
            "_id": doc_id,
            "created_at": (existing or {}).get("created_at", now),
            "updated_at": now,
        }
        return doc_id

    async def get_content(self, note_uuid: str) -> Optional[dict]:
        doc = self.contents.get(note_uuid)
        if doc is None:
            return None
        return {**doc, "_id": str(doc["_id"])}

    async def delete_content(self, note_uuid: str) -> int:
        if note_uuid in self.contents:
            del self.contents[note_uuid]
            return 1
        return 0

    async def insert_revision(
        self,
        note_uuid: str,
        content_md: str,
        revision_note: Optional[str] = None,
    ) -> str:
        rev = {
            "revision_id": f"rev-{_uuid.uuid4().hex[:8]}",
            "note_uuid": note_uuid,
            "content_md": content_md,
            "revision_note": revision_note,
            "created_at": datetime.now(timezone.utc),
        }
        self.revisions.setdefault(note_uuid, []).append(rev)
        return rev["revision_id"]

    async def list_revisions(
        self, note_uuid: str, *, limit: int = 100
    ) -> list[dict]:
        revs = list(reversed(self.revisions.get(note_uuid, [])))
        # Strip content_md for parity with real repo.
        return [
            {k: v for k, v in r.items() if k != "content_md"}
            for r in revs[:limit]
        ]

    async def get_revision(self, revision_id: str) -> Optional[dict]:
        for revs in self.revisions.values():
            for r in revs:
                if r["revision_id"] == revision_id:
                    return dict(r)
        return None

    def content_hash(self, content_md: str) -> str:
        import hashlib

        return hashlib.sha256(content_md.encode("utf-8")).hexdigest()


@pytest.fixture
def fake_mongo(monkeypatch):
    fake = _FakeMongo()
    import app.repository.mongo_note_repository as mod

    monkeypatch.setattr(mod, "upsert_content", fake.upsert_content)
    monkeypatch.setattr(mod, "get_content", fake.get_content)
    monkeypatch.setattr(mod, "delete_content", fake.delete_content)
    monkeypatch.setattr(mod, "insert_revision", fake.insert_revision)
    monkeypatch.setattr(mod, "list_revisions", fake.list_revisions)
    monkeypatch.setattr(mod, "get_revision", fake.get_revision)
    monkeypatch.setattr(mod, "content_hash", fake.content_hash)
    return fake


@pytest.fixture
def service(fake_mongo):
    return NoteService(repo=NoteRepository())


# ─── Create ─────────────────────────────────────────────────────────


class TestCreateNote:
    @pytest.mark.asyncio
    async def test_create_writes_both_stores(self, service, test_db, fake_mongo):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="第一条",
            target_type="video",
            target_id="BV1xx:123",
            content_md="# hello",
        )
        assert meta["title"] == "第一条"
        assert meta["target_type"] == "video"
        assert meta["target_id"] == "BV1xx:123"
        assert meta["content_length"] == len("# hello")

        # Mongo side has the content.
        doc = fake_mongo.contents[meta["uuid"]]
        assert doc["content_md"] == "# hello"
        assert doc["uid"] == 1

    @pytest.mark.asyncio
    async def test_create_rejects_invalid_target_type(
        self, service, test_db
    ):
        with pytest.raises(ValueError, match="invalid target_type"):
            await service.create_note(
                test_db,
                uid=1,
                title="x",
                target_type="bogus",
                target_id="y",
            )

    @pytest.mark.asyncio
    async def test_create_sanitises_content(self, service, test_db, fake_mongo):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="x",
            target_type="video",
            target_id="b:c",
            content_md="hello <script>x</script>",
        )
        stored = fake_mongo.contents[meta["uuid"]]["content_md"]
        assert "<script>" not in stored
        assert "alert" not in stored
        assert stored.startswith("hello")


# ─── Read / list ────────────────────────────────────────────────────


class TestGetNote:
    @pytest.mark.asyncio
    async def test_get_returns_content_and_meta(self, service, test_db):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
            content_md="body",
        )
        detail = await service.get_note(test_db, meta["uuid"], uid=1)
        assert detail["content_md"] == "body"
        assert detail["title"] == "t"

    @pytest.mark.asyncio
    async def test_get_missing_raises(self, service, test_db):
        with pytest.raises(NoteNotFoundError):
            await service.get_note(test_db, "nonexistent-uuid", uid=1)

    @pytest.mark.asyncio
    async def test_get_other_users_note_raises_not_found(
        self, service, test_db
    ):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
        )
        with pytest.raises(NoteNotFoundError):
            await service.get_note(test_db, meta["uuid"], uid=2)


class TestListNotes:
    @pytest.mark.asyncio
    async def test_list_only_returns_caller_notes(self, service, test_db):
        await service.create_note(
            test_db,
            uid=1,
            title="u1-a",
            target_type="video",
            target_id="b:c",
        )
        await service.create_note(
            test_db,
            uid=2,
            title="u2-a",
            target_type="video",
            target_id="b:d",
        )
        notes, total = await service.list_notes(test_db, 1)
        assert total == 1
        assert notes[0]["title"] == "u1-a"

    @pytest.mark.asyncio
    async def test_list_filter_by_target(self, service, test_db):
        await service.create_note(
            test_db,
            uid=1,
            title="a",
            target_type="video",
            target_id="b:1",
        )
        await service.create_note(
            test_db,
            uid=1,
            title="b",
            target_type="video",
            target_id="b:2",
        )
        notes, total = await service.list_notes(
            test_db, 1, target_type="video", target_id="b:1"
        )
        assert total == 1
        assert notes[0]["title"] == "a"


# ─── Update ─────────────────────────────────────────────────────────


class TestUpdateNote:
    @pytest.mark.asyncio
    async def test_update_writes_new_content(self, service, test_db, fake_mongo):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
            content_md="v1",
        )
        await service.update_note(
            test_db, meta["uuid"], uid=1, content_md="v2"
        )
        assert fake_mongo.contents[meta["uuid"]]["content_md"] == "v2"

    @pytest.mark.asyncio
    async def test_update_skips_mongo_when_content_unchanged(
        self, service, test_db, fake_mongo
    ):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
            content_md="same",
        )
        before = fake_mongo.contents[meta["uuid"]]["updated_at"]
        await asyncio.sleep(0.01)
        await service.update_note(
            test_db, meta["uuid"], uid=1, content_md="same"
        )
        after = fake_mongo.contents[meta["uuid"]]["updated_at"]
        # Hash short-circuit — Mongo doc untouched.
        assert before == after

    @pytest.mark.asyncio
    async def test_update_with_stale_if_match_raises_conflict(
        self, service, test_db
    ):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
        )
        stale = meta["updated_at"] - timedelta(seconds=10)
        with pytest.raises(NoteConflictError):
            await service.update_note(
                test_db,
                meta["uuid"],
                uid=1,
                content_md="new",
                if_match=stale,
            )

    @pytest.mark.asyncio
    async def test_update_other_users_note_raises_not_found(
        self, service, test_db
    ):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
        )
        with pytest.raises(NoteNotFoundError):
            await service.update_note(
                test_db, meta["uuid"], uid=2, content_md="x"
            )


# ─── Delete ─────────────────────────────────────────────────────────


class TestDeleteNote:
    @pytest.mark.asyncio
    async def test_soft_delete_hides_from_list(self, service, test_db):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
        )
        await service.delete_note(test_db, meta["uuid"], uid=1)
        notes, total = await service.list_notes(test_db, 1)
        assert total == 0
        # get_note also 404s.
        with pytest.raises(NoteNotFoundError):
            await service.get_note(test_db, meta["uuid"], uid=1)

    @pytest.mark.asyncio
    async def test_delete_revokes_shares(self, service, test_db):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
        )
        share = await service.create_share(test_db, meta["uuid"], uid=1)
        await service.delete_note(test_db, meta["uuid"], uid=1)
        with pytest.raises(NoteNotFoundError):
            await service.get_shared_view(test_db, share["share_token"])


# ─── Sharing ────────────────────────────────────────────────────────


class TestSharing:
    @pytest.mark.asyncio
    async def test_create_share_returns_url(self, service, test_db):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
        )
        share = await service.create_share(test_db, meta["uuid"], uid=1)
        assert share["share_token"]
        assert share["share_url"].startswith("/notes/shared/")

    @pytest.mark.asyncio
    async def test_shared_view_increments_view_count(
        self, service, test_db
    ):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
            content_md="hello",
        )
        share = await service.create_share(test_db, meta["uuid"], uid=1)
        v1 = await service.get_shared_view(test_db, share["share_token"])
        v2 = await service.get_shared_view(test_db, share["share_token"])
        assert v2["view_count"] == v1["view_count"] + 1

    @pytest.mark.asyncio
    async def test_shared_view_does_not_leak_author_uid(
        self, service, test_db
    ):
        """M4: public share view must not expose author_uid."""
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
            content_md="hello",
        )
        share = await service.create_share(test_db, meta["uuid"], uid=1)
        view = await service.get_shared_view(test_db, share["share_token"])
        assert "author_uid" not in view

    @pytest.mark.asyncio
    async def test_revoke_share_blocks_access(self, service, test_db):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
        )
        share = await service.create_share(test_db, meta["uuid"], uid=1)
        await service.revoke_share(test_db, meta["uuid"], uid=1)
        with pytest.raises(NoteNotFoundError):
            await service.get_shared_view(test_db, share["share_token"])

    @pytest.mark.asyncio
    async def test_expired_share_blocks_access(self, service, test_db):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
        )
        share = await service.create_share(
            test_db, meta["uuid"], uid=1, expires_in_days=1
        )
        # Manually expire it via the repo to simulate time passing.
        from app.models import NoteShare
        from sqlalchemy import select

        result = await test_db.execute(
            select(NoteShare).where(NoteShare.share_token == share["share_token"])
        )
        share_row = result.scalar_one()
        share_row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await test_db.commit()

        with pytest.raises(NoteNotFoundError):
            await service.get_shared_view(test_db, share["share_token"])

    @pytest.mark.asyncio
    async def test_create_share_revokes_prior_active(
        self, service, test_db
    ):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
        )
        s1 = await service.create_share(test_db, meta["uuid"], uid=1)
        s2 = await service.create_share(test_db, meta["uuid"], uid=1)
        # Old token should no longer work.
        with pytest.raises(NoteNotFoundError):
            await service.get_shared_view(test_db, s1["share_token"])
        # New token works.
        view = await service.get_shared_view(test_db, s2["share_token"])
        assert view["title"] == "t"


# ─── Anchors ────────────────────────────────────────────────────────


class TestAnchors:
    @pytest.mark.asyncio
    async def test_add_and_list_anchor(self, service, test_db):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
        )
        a = await service.add_anchor(
            test_db,
            meta["uuid"],
            uid=1,
            block_id="blk-1",
            position=42,
            label="关键点",
        )
        assert a["block_id"] == "blk-1"
        assert a["position"] == 42

        detail = await service.get_note(test_db, meta["uuid"], uid=1)
        assert len(detail["anchors"]) == 1
        assert detail["anchors"][0]["block_id"] == "blk-1"

    @pytest.mark.asyncio
    async def test_delete_anchor(self, service, test_db):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
        )
        a = await service.add_anchor(
            test_db,
            meta["uuid"],
            uid=1,
            block_id="blk-1",
            position=10,
            label=None,
        )
        await service.delete_anchor(test_db, meta["uuid"], a["id"], uid=1)
        detail = await service.get_note(test_db, meta["uuid"], uid=1)
        assert len(detail["anchors"]) == 0

    @pytest.mark.asyncio
    async def test_anchor_cross_user_isolation(self, service, test_db):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
        )
        with pytest.raises(NoteNotFoundError):
            await service.add_anchor(
                test_db,
                meta["uuid"],
                uid=2,
                block_id="x",
                position=0,
                label=None,
            )


# ─── Revisions ──────────────────────────────────────────────────────


class TestRevisions:
    @pytest.mark.asyncio
    async def test_list_revisions_empty_initially(self, service, test_db):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
            content_md="v1",
        )
        revs = await service.list_revisions(test_db, meta["uuid"], uid=1)
        assert revs == []

    @pytest.mark.asyncio
    async def test_restore_revision(self, service, test_db, fake_mongo):
        meta = await service.create_note(
            test_db,
            uid=1,
            title="t",
            target_type="video",
            target_id="b:c",
            content_md="v1",
        )
        # Force a revision snapshot.
        rev_id = await fake_mongo.insert_revision(
            meta["uuid"], "old-content", revision_note="manual"
        )
        await service.restore_revision(
            test_db, meta["uuid"], rev_id, uid=1
        )
        detail = await service.get_note(test_db, meta["uuid"], uid=1)
        assert detail["content_md"] == "old-content"
        # restore_revision bumps revision_count by 1 (0 → 1).
        assert detail["revision_count"] == 1
        # A "restored from ..." revision snapshot is also recorded.
        assert len(fake_mongo.revisions[meta["uuid"]]) == 2
