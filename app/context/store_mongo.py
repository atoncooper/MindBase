"""MongoDB-backed conversation store.

Stores and retrieves conversation context from the ``chat_messages``
collection, reusing the project's existing Motor client and indexes.

Drop-in replacement for ``InMemoryStore`` when persistence across
restarts or multi-process deployments is required.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from pymongo import ASCENDING

from .config import ContextConfig
from .models import ConversationContext, ConversationMessage
from .store import ConversationStore

if TYPE_CHECKING:
    from datetime import datetime

logger = logging.getLogger(__name__)

COLLECTION = "chat_messages"
DEFAULT_LOAD_LIMIT = 2000  # safety cap — won't load more than this


def _mongo_doc_to_message(doc: dict) -> ConversationMessage:
    """Convert a MongoDB chat_messages document to ConversationMessage."""
    created_at = doc.get("created_at")
    if isinstance(created_at, (int, float)):
        ts = float(created_at)
    elif hasattr(created_at, "timestamp"):
        ts = created_at.timestamp()
    else:
        import time
        ts = time.time()
    role = doc.get("role", "user")
    if role == "system":
        role = "assistant"
    return ConversationMessage(
        role=role,
        content=doc.get("content", ""),
        timestamp=ts,
    )


def _message_to_mongo_doc(
    session_id: str, message: ConversationMessage, uid: int = 0
) -> dict:
    """Convert a ConversationMessage to a minimal MongoDB insert document."""
    from datetime import datetime, timezone

    return {
        "chat_session_id": session_id,
        "uid": uid,
        "role": message.role,
        "content": message.content,
        "status": "completed",
        "created_at": datetime.fromtimestamp(
            message.timestamp, tz=timezone.utc
        ),
    }


class MongoStore(ConversationStore):
    """MongoDB-backed conversation store.

    Each ``ConversationMessage`` maps to one document in ``chat_messages``.
    The store provides the same interface as ``InMemoryStore`` so it can
    be swapped in without changing ``ContextManager``.

    Parameters:
        config: ContextConfig (used for TTL and load limits).
        uid: Default user id for inserted documents (0 = anonymous).
        load_limit: Maximum messages loaded per session.
    """

    def __init__(
        self,
        config: ContextConfig,
        uid: int = 0,
        load_limit: int = DEFAULT_LOAD_LIMIT,
    ) -> None:
        self._config = config
        self._uid = uid
        self._load_limit = load_limit
        self._locks: dict[str, asyncio.Lock] = {}
        self._global_lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # lock helpers
    # ------------------------------------------------------------------

    async def _get_lock(self, session_id: str) -> asyncio.Lock:
        if session_id in self._locks:
            return self._locks[session_id]
        async with self._global_lock:
            if session_id not in self._locks:
                self._locks[session_id] = asyncio.Lock()
            return self._locks[session_id]

    # ------------------------------------------------------------------
    # store API
    # ------------------------------------------------------------------

    async def load(self, session_id: str) -> ConversationContext | None:
        from app.infra.mongo import coll, is_enabled

        if not is_enabled():
            logger.warning("[MONGO_STORE] mongo disabled, returning None")
            return None

        lock = await self._get_lock(session_id)
        async with lock:
            cursor = (
                coll(COLLECTION)
                .find({"chat_session_id": session_id})
                .sort("created_at", ASCENDING)
                .limit(self._load_limit)
            )
            docs = await cursor.to_list(length=self._load_limit)
            if not docs:
                return None

            messages = [_mongo_doc_to_message(d) for d in docs]
            first_ts = messages[0].timestamp
            last_ts = messages[-1].timestamp

            return ConversationContext(
                session_id=session_id,
                messages=messages,
                created_at=first_ts,
                updated_at=last_ts,
            )

    async def save(self, session_id: str, context: ConversationContext) -> None:
        from app.infra.mongo import coll, is_enabled

        if not is_enabled():
            return

        lock = await self._get_lock(session_id)
        async with lock:
            # Remove existing messages for this session, then bulk-insert
            await coll(COLLECTION).delete_many({"chat_session_id": session_id})
            if context.messages:
                docs = [
                    _message_to_mongo_doc(session_id, m, self._uid)
                    for m in context.messages
                ]
                await coll(COLLECTION).insert_many(docs)
            context.touch()

    async def append(self, session_id: str, message: ConversationMessage) -> None:
        from app.infra.mongo import coll, is_enabled

        if not is_enabled():
            return

        lock = await self._get_lock(session_id)
        async with lock:
            doc = _message_to_mongo_doc(session_id, message, self._uid)
            await coll(COLLECTION).insert_one(doc)

    async def append_batch(self, session_id: str, messages: list[ConversationMessage]) -> None:
        from app.infra.mongo import coll, is_enabled

        if not is_enabled():
            return

        lock = await self._get_lock(session_id)
        async with lock:
            docs = [_message_to_mongo_doc(session_id, m, self._uid) for m in messages]
            await coll(COLLECTION).insert_many(docs)

    async def delete(self, session_id: str) -> bool:
        from app.infra.mongo import coll, is_enabled

        if not is_enabled():
            return False

        lock = await self._get_lock(session_id)
        async with lock:
            result = await coll(COLLECTION).delete_many(
                {"chat_session_id": session_id}
            )
            return result.deleted_count > 0

    async def exists(self, session_id: str) -> bool:
        from app.infra.mongo import coll, is_enabled

        if not is_enabled():
            return False

        count = await coll(COLLECTION).count_documents(
            {"chat_session_id": session_id}, limit=1
        )
        return count > 0

    async def session_count(self) -> int:
        from app.infra.mongo import coll, is_enabled

        if not is_enabled():
            return 0

        pipeline = [
            {"$group": {"_id": "$chat_session_id"}},
            {"$count": "total"},
        ]
        result = await coll(COLLECTION).aggregate(pipeline).to_list(length=1)
        return result[0]["total"] if result else 0

    async def cleanup_expired(self, ttl_seconds: float) -> int:
        """Delete messages from sessions idle longer than *ttl_seconds*."""
        from datetime import datetime, timedelta, timezone
        from app.infra.mongo import coll, is_enabled

        if not is_enabled() or ttl_seconds <= 0:
            return 0

        cutoff = datetime.now(timezone.utc) - timedelta(seconds=ttl_seconds)

        # Find stale session ids
        pipeline = [
            {"$sort": {"created_at": -1}},
            {
                "$group": {
                    "_id": "$chat_session_id",
                    "last_active": {"$first": "$created_at"},
                }
            },
            {"$match": {"last_active": {"$lt": cutoff}}},
        ]
        stale = await coll(COLLECTION).aggregate(pipeline).to_list(length=1000)
        stale_ids = [doc["_id"] for doc in stale]

        if not stale_ids:
            return 0

        result = await coll(COLLECTION).delete_many(
            {"chat_session_id": {"$in": stale_ids}}
        )
        removed = result.deleted_count
        if removed:
            logger.info(
                "[MONGO_STORE] cleanup_expired sessions={} docs={}",
                len(stale_ids),
                removed,
            )
        return removed
