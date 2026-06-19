"""Process-local WebSocket connection registry and broadcast helpers.

Lives in the service layer so that both ``routers/tasks_ws.py`` (which
accepts WS connections) and ``services/doc_parser/vectorize.py`` (which
pushes cloud-file vectorization progress) can share the same connection
pool without services importing from routers.

This module owns no HTTP / WebSocket endpoint — it only stores
``WebSocket`` objects handed to it by the router and pushes JSON frames
back through them.  The router remains responsible for auth, accept,
and lifecycle; this registry is purely the shared state plus the
broadcast fan-out.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)

# uid -> set of live WebSockets for that user
_active_connections: dict[int, set[WebSocket]] = {}

MAX_PER_UID = 3
MAX_TOTAL = 50


def total_count() -> int:
    return sum(len(v) for v in _active_connections.values())


def connections_for(uid: int) -> set[WebSocket]:
    """Return the (possibly empty) set of live sockets for *uid*."""
    return _active_connections.get(uid, set())


def register(uid: int, ws: WebSocket) -> None:
    """Add *ws* to the registry. Caller must have already accepted it."""
    _active_connections.setdefault(uid, set()).add(ws)


def unregister(uid: int, ws: WebSocket) -> None:
    """Remove *ws*; drop the uid bucket if it becomes empty."""
    bucket = _active_connections.get(uid)
    if bucket is None:
        return
    bucket.discard(ws)
    if not bucket:
        _active_connections.pop(uid, None)


def within_limits(uid: int) -> bool:
    """True if accepting one more connection for *uid* stays under caps."""
    if total_count() >= MAX_TOTAL:
        return False
    if len(_active_connections.get(uid, set())) >= MAX_PER_UID:
        return False
    return True


def evict_oldest(uid: int, keep: int = MAX_PER_UID) -> list[WebSocket]:
    """Evict oldest connections for *uid* so that at most *keep* remain.

    Returns the evicted sockets so the caller can close them.
    """
    bucket = _active_connections.get(uid)
    if bucket is None:
        return []
    evicted: list[WebSocket] = []
    while len(bucket) > keep - 1:
        # sets are unordered; pick any via iter() — caller closes them
        ws = next(iter(bucket), None)
        if ws is None:
            break
        bucket.discard(ws)
        evicted.append(ws)
    return evicted


async def broadcast_cloud_status(
    uid: int,
    upload_uuid: str,
    status: str,
    chunk_count: int = 0,
    error: str = "",
) -> None:
    """Push cloud-file vectorization status to all of a user's connections."""
    connections = _active_connections.get(uid, set())
    if not connections:
        logger.debug("[CLOUD_WS] no connections for uid=%s, status not pushed", uid)
        return

    payload = json.dumps(
        {
            "type": "cloud_processing",
            "upload_uuid": upload_uuid,
            "status": status,
            "chunk_count": chunk_count,
            "error": error,
            "timestamp": time.time(),
        }
    )

    dead: list[WebSocket] = []
    for ws in connections:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        # Use the same unregister path so the bucket cleanup is consistent.
        connections.discard(ws)
    if dead and not connections:
        _active_connections.pop(uid, None)


async def broadcast_task_update(uid: int, task: dict[str, Any]) -> None:
    """Push a generic task update to all of a user's connections."""
    connections = _active_connections.get(uid, set())
    if not connections:
        return
    dead: list[WebSocket] = []
    for ws in connections:
        try:
            await ws.send_json({"type": "task_update", "task": task})
        except Exception:
            dead.append(ws)
    for ws in dead:
        connections.discard(ws)
    if dead and not connections:
        _active_connections.pop(uid, None)
