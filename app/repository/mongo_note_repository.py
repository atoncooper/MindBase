"""MongoDB repository for note content (note_documents / note_revisions).

MySQL notes stores metadata only; the markdown body lives here.
Revision snapshots are written on a coarse trigger (time / size threshold)
to avoid unbounded growth — see services/notes/service.py for the policy.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Optional

from loguru import logger
from pymongo import UpdateOne

from app.infra.mongo import coll, is_enabled

COLLECTION = "note_documents"
REVISIONS_COLLECTION = "note_revisions"


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Content documents ─────────────────────────────────────────────


async def upsert_content(
    note_uuid: str,
    uid: int,
    content_md: str,
    *,
    blocks_json: Optional[list] = None,
) -> str:
    """Insert or replace the content document for a note.

    Returns the string form of the MongoDB _id. Raises RuntimeError if
    MongoDB is disabled.
    """
    if not is_enabled():
        raise RuntimeError("MongoDB is not connected — note content cannot be saved")

    now = _now()
    doc = {
        "note_uuid": note_uuid,
        "uid": uid,
        "content_md": content_md,
        "blocks_json": blocks_json,
        "updated_at": now,
    }

    # Upsert by note_uuid (unique index). On insert, set created_at too.
    op = UpdateOne(
        {"note_uuid": note_uuid},
        {
            "$set": doc,
            "$setOnInsert": {"created_at": now},
        },
        upsert=True,
    )
    result = await coll(COLLECTION).bulk_write([op], ordered=False)

    # Fetch the _id (upserted or existing)
    cursor = coll(COLLECTION).find({"note_uuid": note_uuid}, {"_id": 1})
    docs = await cursor.to_list(length=1)
    if not docs:
        raise RuntimeError("note document disappeared after upsert")
    doc_id = str(docs[0]["_id"])

    logger.debug(
        f"[MONGO_NOTE] upserted note_uuid={note_uuid} "
        f"(upserted={result.upserted_count}, modified={result.modified_count})"
    )
    return doc_id


async def get_content(note_uuid: str) -> Optional[dict]:
    """Return the content document, or None if missing / Mongo disabled."""
    if not is_enabled():
        logger.warning(f"[MONGO_NOTE] MongoDB disabled, cannot read {note_uuid}")
        return None
    cursor = coll(COLLECTION).find({"note_uuid": note_uuid}).limit(1)
    docs = await cursor.to_list(length=1)
    if not docs:
        return None
    doc = docs[0]
    doc["_id"] = str(doc["_id"])
    return doc


async def delete_content(note_uuid: str) -> int:
    """Delete the content document. Returns deleted count (0 if disabled)."""
    if not is_enabled():
        return 0
    result = await coll(COLLECTION).delete_many({"note_uuid": note_uuid})
    logger.info(
        f"[MONGO_NOTE] deleted content note_uuid={note_uuid} count={result.deleted_count}"
    )
    return result.deleted_count


# ── Revisions ─────────────────────────────────────────────────────


async def insert_revision(
    note_uuid: str,
    content_md: str,
    revision_note: Optional[str] = None,
) -> str:
    """Append a revision snapshot. Returns the revision id (str)."""
    if not is_enabled():
        raise RuntimeError("MongoDB is not connected — revision cannot be saved")
    doc = {
        "note_uuid": note_uuid,
        "content_md": content_md,
        "revision_note": revision_note,
        "created_at": _now(),
    }
    result = await coll(REVISIONS_COLLECTION).insert_one(doc)
    return str(result.inserted_id)


async def list_revisions(
    note_uuid: str, *, limit: int = 100
) -> list[dict]:
    """Return revisions newest-first, excluding the live content."""
    if not is_enabled():
        return []
    cursor = (
        coll(REVISIONS_COLLECTION)
        .find({"note_uuid": note_uuid}, {"content_md": 0})
        .sort("created_at", -1)
        .limit(limit)
    )
    docs = await cursor.to_list(length=limit)
    for d in docs:
        d["revision_id"] = str(d.pop("_id"))
    return docs


async def get_revision(revision_id: str) -> Optional[dict]:
    """Fetch a single revision including content. None if missing."""
    if not is_enabled():
        return None
    from bson import ObjectId
    try:
        oid = ObjectId(revision_id)
    except Exception:
        return None
    doc = await coll(REVISIONS_COLLECTION).find_one({"_id": oid})
    if doc is None:
        return None
    doc["revision_id"] = str(doc.pop("_id"))
    return doc


# ── Helpers ───────────────────────────────────────────────────────


def content_hash(content_md: str) -> str:
    """SHA-256 hex digest — used by service layer for dirty check."""
    return hashlib.sha256(content_md.encode("utf-8")).hexdigest()
