"""
MongoDB helper for ASR document CRUD.

ASR text content is stored in MongoDB (asr_documents collection).
MySQL video table stores only metadata — find the MongoDB doc via bvid + cid.

Collection: asr_documents
Document:
    {
        "video_id":    int,       // bv_to_av(bvid), maps to SQL video_cache.id
        "bvid":        str,
        "cid":         int,
        "page_index":  int,
        "page_title":  str,
        "content":     str,       // ASR transcription full text
        "content_source": str,    // "asr" | "subtitle" | "user_edit"
        "version":     int,
        "is_latest":   bool,
        "created_at":  datetime,
    }
Indexes:
    { "bvid": 1, "cid": 1, "version": -1 }
    { "bvid": 1, "cid": 1, "is_latest": 1 }
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from loguru import logger
from pymongo import ASCENDING, DESCENDING, IndexModel

from app.infra.mongo import coll, is_enabled

COLLECTION = "asr_documents"

INDEXES: list[IndexModel] = [
    IndexModel(
        [("bvid", ASCENDING), ("cid", ASCENDING), ("version", DESCENDING)],
        name="idx_bvid_cid_version",
    ),
    IndexModel(
        [("bvid", ASCENDING), ("cid", ASCENDING), ("is_latest", ASCENDING)],
        name="idx_bvid_cid_latest",
    ),
    IndexModel([("video_id", ASCENDING)], name="idx_video_id"),
]


async def ensure_indexes() -> None:
    """Idempotent index creation."""
    if not is_enabled():
        return
    try:
        await coll(COLLECTION).create_indexes(INDEXES)
        logger.debug(f"[MONGO_ASR] indexes ensured for {COLLECTION}")
    except Exception as e:
        logger.warning(f"[MONGO_ASR] index error: {e}")


async def save_asr(
    *,
    video_id: int,
    bvid: str,
    cid: int,
    page_index: int,
    page_title: str,
    content: str,
    content_source: str = "asr",
    version: int = 1,
) -> str:
    """Save a new ASR document. Returns the inserted _id as string."""
    if not is_enabled():
        raise RuntimeError("[MONGO_ASR] MongoDB not enabled")

    # Mark previous versions as not latest
    await coll(COLLECTION).update_many(
        {"bvid": bvid, "cid": cid, "is_latest": True},
        {"$set": {"is_latest": False}},
    )

    doc = {
        "video_id": video_id,
        "bvid": bvid,
        "cid": cid,
        "page_index": page_index,
        "page_title": page_title,
        "content": content,
        "content_source": content_source,
        "version": version,
        "is_latest": True,
        "created_at": datetime.now(timezone.utc),
    }
    result = await coll(COLLECTION).insert_one(doc)
    logger.info(f"[MONGO_ASR] saved bvid={bvid} cid={cid} v{version}")
    return str(result.inserted_id)


async def get_latest(bvid: str, cid: int) -> Optional[dict[str, Any]]:
    """Get the latest ASR document for a bvid + cid."""
    if not is_enabled():
        return None
    return await coll(COLLECTION).find_one(
        {"bvid": bvid, "cid": cid, "is_latest": True},
        sort=[("version", DESCENDING)],
    )


async def get_version(bvid: str, cid: int, version: int) -> Optional[dict[str, Any]]:
    """Get a specific version of an ASR document."""
    if not is_enabled():
        return None
    return await coll(COLLECTION).find_one(
        {"bvid": bvid, "cid": cid, "version": version},
    )


async def list_versions(bvid: str, cid: int) -> list[dict[str, Any]]:
    """List all versions for a bvid + cid, newest first."""
    if not is_enabled():
        return []
    cursor = coll(COLLECTION).find(
        {"bvid": bvid, "cid": cid},
    ).sort("version", DESCENDING)
    return await cursor.to_list(length=100)


async def delete_all(bvid: str, cid: int) -> int:
    """Delete all versions for a bvid + cid. Returns count deleted."""
    if not is_enabled():
        return 0
    result = await coll(COLLECTION).delete_many({"bvid": bvid, "cid": cid})
    return result.deleted_count


async def count_documents() -> int:
    """Total ASR documents in the collection."""
    if not is_enabled():
        return 0
    return await coll(COLLECTION).estimated_document_count()


async def get_preview(bvid: str, cid: int, max_length: int = 200) -> Optional[str]:
    """Get a short preview of the latest ASR content."""
    doc = await get_latest(bvid, cid)
    if not doc:
        return None
    content = doc.get("content", "")
    return content[:max_length] if content else None
