"""Async MongoDB client via Motor.

Lazy initialisation: call ``init()`` during application startup.
If ``mongo.enabled`` is false the module skips connection entirely.

Usage:
    from app.infra.mongo import init, close, coll, is_enabled

    # startup
    await init()

    # query
    await coll("chat_messages").insert_one({"uid": 1, "text": "hello"})

    # shutdown
    await close()
"""

from __future__ import annotations

import time
from typing import Any

from loguru import logger
from pymongo import ASCENDING, DESCENDING, IndexModel
from pymongo.errors import OperationFailure

from app.infra.config import config

# Module-level state — populated by init()
_client: Any | None = None
db: Any | None = None

# ---------------------------------------------------------------------------
# Index declarations — created once at startup
# ---------------------------------------------------------------------------

INDEXES: dict[str, list[IndexModel]] = {
    "chat_messages": [
        IndexModel([("chat_session_id", ASCENDING), ("created_at", ASCENDING)]),
        IndexModel([("uid", ASCENDING), ("created_at", DESCENDING)]),
        IndexModel([("msg_id", ASCENDING)], unique=True),
        IndexModel([("sources.bvid", ASCENDING)]),
    ],
    "quiz_questions": [
        IndexModel([("question_uuid", ASCENDING)], unique=True),
        IndexModel([("quiz_uuid", ASCENDING), ("created_at", ASCENDING)]),
        IndexModel([("uid", ASCENDING), ("created_at", DESCENDING)]),
        IndexModel([("bvid", ASCENDING)]),
    ],
    "quiz_answers": [
        IndexModel(
            [("submission_uuid", ASCENDING), ("question_index", ASCENDING)],
            unique=True,
        ),
        IndexModel(
            [
                ("uid", ASCENDING),
                ("is_correct", ASCENDING),
                ("submitted_at", DESCENDING),
            ]
        ),
    ],
    "operation_log": [
        IndexModel(
            [("created_at", ASCENDING)],
            expireAfterSeconds=60 * 60 * 24 * 30,
        ),
        IndexModel([("uid", ASCENDING), ("created_at", DESCENDING)]),
        IndexModel([("action", ASCENDING), ("created_at", DESCENDING)]),
    ],
    "asr_documents": [
        IndexModel([("bvid", ASCENDING), ("cid", ASCENDING), ("version", DESCENDING)]),
        IndexModel([("bvid", ASCENDING), ("cid", ASCENDING), ("is_latest", ASCENDING)]),
        IndexModel([("video_id", ASCENDING)]),
    ],
    "cloud_drive_documents": [
        IndexModel([("upload_uuid", ASCENDING)], unique=True),
        IndexModel([("uid", ASCENDING), ("created_at", DESCENDING)]),
        IndexModel([("uid", ASCENDING), ("source_type", ASCENDING)]),
    ],
    "note_documents": [
        IndexModel([("note_uuid", ASCENDING)], unique=True),
        IndexModel([("uid", ASCENDING), ("updated_at", DESCENDING)]),
    ],
    "note_revisions": [
        IndexModel([("note_uuid", ASCENDING), ("created_at", DESCENDING)]),
    ],
}


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


async def init() -> None:
    """Connect to MongoDB and ensure indexes.

    No-op when ``mongo.enabled`` is false.  Connection failures are
    logged as warnings (Mongo is treated as an optional dependency).
    """
    global _client, db

    if not config.mongo.enabled:
        logger.info("[MONGO] disabled, skipping init")
        return

    # Delay import so the module loads even when motor is not installed.
    from motor.motor_asyncio import AsyncIOMotorClient

    _client = AsyncIOMotorClient(
        config.mongo.uri,
        minPoolSize=config.mongo.min_pool_size,
        maxPoolSize=config.mongo.max_pool_size,
        serverSelectionTimeoutMS=config.mongo.server_selection_timeout_ms,
        connectTimeoutMS=config.mongo.connect_timeout_ms,
        appname=config.app.name,
    )
    db = _client[config.mongo.db_name]

    result = await ping()
    if not result["ok"]:
        logger.warning("[MONGO] init failed (continuing): {}", result["error"])
        _client = None
        db = None
        return

    await _drop_stale_indexes()
    await _ensure_indexes()
    logger.info(
        "[MONGO] connected: db={}, latency={}ms",
        config.mongo.db_name,
        result["latency_ms"],
    )


async def _drop_stale_indexes() -> None:
    """Drop old indexes that are no longer declared and may conflict."""
    if db is None:
        return
    drops = {
        "quiz_questions": ["quiz_uuid_1_question_index_1"],
    }
    for collection, index_names in drops.items():
        for name in index_names:
            try:
                await db[collection].drop_index(name)
                logger.info("[MONGO] dropped stale index {}.{}", collection, name)
            except OperationFailure:
                pass  # already gone


async def _ensure_indexes() -> None:
    """Idempotent index creation for all declared collections."""
    if db is None:
        return
    for collection, indexes in INDEXES.items():
        try:
            await db[collection].create_indexes(indexes)
            logger.debug("[MONGO] indexes ensured: {} ({})", collection, len(indexes))
        except OperationFailure as exc:
            logger.warning("[MONGO] index conflict on {}: {}", collection, exc)


async def close() -> None:
    """Close the client and release the connection pool."""
    global _client, db
    if _client is not None:
        _client.close()
        _client = None
        db = None
    logger.info("[MONGO] closed")


async def ping() -> dict[str, Any]:
    """Return connection health with round-trip latency in milliseconds."""
    if _client is None:
        return {"ok": False, "latency_ms": 0, "error": "not initialized"}
    start = time.time()
    try:
        await _client.admin.command("ping")
        return {
            "ok": True,
            "latency_ms": int((time.time() - start) * 1000),
            "error": None,
        }
    except Exception as exc:
        return {
            "ok": False,
            "latency_ms": int((time.time() - start) * 1000),
            "error": str(exc),
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def coll(name: str) -> Any:
    """Return a collection handle.  Raises if Mongo is disabled."""
    if db is None:
        raise RuntimeError("[MONGO] not initialized or disabled")
    return db[name]


def is_enabled() -> bool:
    """Return True if Mongo is enabled and connected."""
    return db is not None


def get_database() -> Any | None:
    """Return the raw Motor database handle, or None if not initialized."""
    return db
