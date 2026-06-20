"""WebSocket endpoint for real-time async task status streaming.

Connection state (the per-uid socket pool) and broadcast fan-out live in
``app.services.ws_registry`` so that service-layer code can push status
without importing this router.  This module only owns the WS endpoint,
auth, and the per-connection read loop.

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

from app.services import ws_registry
from app.services.async_task.cache import get_cached_tasks, get_cached_task
from app.services.auth.token import validate_token as _validate_token

router = APIRouter()

PUSH_INTERVAL = 5  # seconds between cache re-checks


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
    if ws_registry.total_count() >= ws_registry.MAX_TOTAL:
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
    existing = ws_registry.connections_for(uid)
    if len(existing) >= ws_registry.MAX_PER_UID:
        evicted = ws_registry.evict_oldest(
            uid, keep=ws_registry.MAX_PER_UID
        )
        for old_ws in evicted:
            try:
                await old_ws.close(code=4003, reason="Superseded by newer connection")
            except Exception:
                pass
        if evicted:
            logger.info(f"[TaskWS] uid={uid} evicted {len(evicted)} stale connections")

    if ws_registry.total_count() >= ws_registry.MAX_TOTAL:
        await websocket.close(code=4002, reason="Server connection limit reached")
        logger.warning(f"[TaskWS] rejected uid={uid} — server total limit exceeded")
        return

    ws_registry.register(uid, websocket)
    logger.info(
        f"[TaskWS] connected uid={uid} "
        f"(user_conns={len(ws_registry.connections_for(uid))} total={ws_registry.total_count()})"
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
        ws_registry.unregister(uid, websocket)
