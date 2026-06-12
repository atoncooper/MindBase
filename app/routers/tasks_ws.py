"""
WebSocket endpoint for real-time async task status streaming.

Security:
  - Token-based auth: client passes ?token=<bearer_token>, server validates
    and extracts uid.  Raw uid is never trusted from the client.
  - Connection limits: max 3 connections per uid, max 50 total.
  - Invalid tokens → 4001 close code before accept.

Cache:
  - Reads from in-memory cache (refreshed by subprocess every 5 min).
  - No DB query per push.
"""

import asyncio
import json
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from loguru import logger

from app.services.async_task.cache import get_cached_tasks, get_cached_task
from app.services.auth.token import validate_token as _validate_token

router = APIRouter()

PUSH_INTERVAL = 5  # seconds between cache re-checks
MAX_PER_UID = 3  # max concurrent connections per user
MAX_TOTAL = 50  # max total connections

# Connected clients: {uid: set[WebSocket]}
_active_connections: dict[int, set[WebSocket]] = {}
_total_count = 0


def _sanitize_token(raw: str) -> str:
    """Strip common prefixes added by frontend / URL encoding."""
    t = raw.strip().lstrip("$")
    if t.lower().startswith("bearer "):
        t = t[7:]
    return t.strip()


async def _authenticate_websocket(
    websocket: WebSocket,
    token: str,
) -> int:
    """Validate token and return uid.  Closes connection on failure."""
    from app.database import async_session_factory

    token = _sanitize_token(token)

    async with async_session_factory() as db:
        uid = await _validate_token(db, token)

    if uid is None:
        logger.warning(f"[TaskWS] auth failed — invalid token prefix={token[:8]}...")
        await websocket.close(code=4001, reason="Invalid or expired token")
        raise WebSocketDisconnect(code=4001)

    logger.info(f"[TaskWS] authenticated uid={uid}")
    return uid


def _check_connection_limits(uid: int) -> bool:
    """Return False if connection limits exceeded (should reject)."""
    global _total_count
    if _total_count >= MAX_TOTAL:
        return False
    existing = len(_active_connections.get(uid, set()))
    if existing >= MAX_PER_UID:
        return False
    return True


@router.websocket("/ws/tasks")
async def task_stream(
    websocket: WebSocket,
    token: str = Query(..., description="Bearer token (required)"),
):
    """WebSocket — real-time async task status.

    Auth: client passes ?token=<bearer_token>.
    Server validates, extracts uid, scopes all data to that uid.

    Client messages:
      {"action": "subscribe", "task_id": "uuid"}   → push single task detail
      {"action": "filter", "task_type": "...", "status": "..."} → filtered list
    """
    # ── Connection limit (before accept, reject early) ──
    if _total_count >= MAX_TOTAL:
        await websocket.close(code=4002, reason="Server connection limit reached")
        return

    # ── Auth ──
    await websocket.accept()

    try:
        uid = await _authenticate_websocket(websocket, token)
    except WebSocketDisconnect:
        return

    # ── Per-uid limit / dedup ──
    # If the user already has connections, close the OLDEST ones before adding new.
    # This handles client-side reconnect without proper cleanup (e.g. React StrictMode).
    existing = _active_connections.get(uid, set())
    if len(existing) >= MAX_PER_UID:
        to_close = list(existing)[: len(existing) - MAX_PER_UID + 1]
        for old_ws in to_close:
            try:
                await old_ws.close(code=4003, reason="Superseded by newer connection")
            except Exception:
                pass
            existing.discard(old_ws)
        logger.info(f"[TaskWS] uid={uid} evicted {len(to_close)} stale connections")

    if _total_count >= MAX_TOTAL:
        await websocket.close(code=4002, reason="Server connection limit reached")
        logger.warning(f"[TaskWS] rejected uid={uid} — server total limit exceeded")
        return

    _active_connections.setdefault(uid, set()).add(websocket)
    _update_total()
    logger.info(
        f"[TaskWS] connected uid={uid} "
        f"(user_conns={len(_active_connections[uid])} total={_total_count})"
    )

    last_cache_hash = 0

    try:
        while True:
            # Push cached tasks if cache has changed
            current_tasks = get_cached_tasks(uid=uid)
            tasks_json = json.dumps(current_tasks, default=str)
            current_hash = hash(tasks_json)

            if current_hash != last_cache_hash:
                await websocket.send_json(
                    {
                        "type": "tasks",
                        "count": len(current_tasks),
                        "tasks": current_tasks,
                        "timestamp": time.time(),
                    }
                )
                last_cache_hash = current_hash

            # Wait for client message (or timeout to re-check cache)
            try:
                msg = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=PUSH_INTERVAL,
                )
                data = json.loads(msg)

                if data.get("action") == "subscribe":
                    task_id = data.get("task_id")
                    if task_id:
                        task = get_cached_task(task_id)
                        if task and task.get("uid") == uid:
                            await websocket.send_json(
                                {
                                    "type": "task_detail",
                                    "task": task,
                                }
                            )
                        else:
                            await websocket.send_json(
                                {
                                    "type": "error",
                                    "message": "Task not found or access denied",
                                }
                            )

                elif data.get("action") == "filter":
                    filtered = get_cached_tasks(
                        uid=uid,
                        task_type=data.get("task_type"),
                        status=data.get("status"),
                    )
                    await websocket.send_json(
                        {
                            "type": "tasks",
                            "count": len(filtered),
                            "tasks": filtered,
                            "timestamp": time.time(),
                        }
                    )
                    last_cache_hash = 0  # force re-push on next cycle

            except asyncio.TimeoutError:
                pass  # No client message, just loop

    except WebSocketDisconnect:
        logger.info(f"[TaskWS] disconnected uid={uid}")
    except Exception:
        logger.exception("[TaskWS] error uid={}", uid)
    finally:
        _active_connections.get(uid, set()).discard(websocket)
        if not _active_connections.get(uid):
            _active_connections.pop(uid, None)
        _update_total()


def _update_total() -> None:
    global _total_count
    _total_count = sum(len(v) for v in _active_connections.values())


async def broadcast_task_update(uid: int, task: dict) -> None:
    """Push a task update to all connected clients for a user."""
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
    if dead:
        _update_total()


async def broadcast_cloud_status(
    uid: int,
    upload_uuid: str,
    status: str,
    chunk_count: int = 0,
    error: str = "",
) -> None:
    """Push cloud file vectorization status to all of a user's WS connections."""
    connections = _active_connections.get(uid, set())
    if not connections:
        logger.debug("[CLOUD_WS] no connections for uid={}, status not pushed", uid)
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
        connections.discard(ws)
    if dead:
        _update_total()

    logger.info(
        "[CLOUD_WS] pushed status={} upload_uuid={} to uid={} ({} conns)",
        status,
        upload_uuid,
        uid,
        len(connections),
    )
