"""Redis pub/sub bridge for cloud-drive processing status.

app-cloud (Go) publishes vectorization state changes to the ``cloud:status``
channel; this bridge subscribes and forwards them to the user's WebSocket
connections via the existing ws_registry — the frontend keeps receiving
``cloud_processing`` pushes without knowing about the Go service.

Lifecycle: started/stopped from app.main lifespan. Redis unavailable at
startup → the bridge retries periodically instead of failing the app.
"""

from __future__ import annotations

import asyncio
import json

from loguru import logger

from app.infra import redis as redis_mod

CHANNEL = "cloud:status"
_RESTART_DELAY = 5.0


async def _handle_message(payload: str) -> None:
    try:
        data = json.loads(payload)
    except (ValueError, TypeError):
        logger.warning("[CLOUD_WS_BRIDGE] invalid payload: %.200s", payload)
        return
    uid = data.get("uid")
    upload_uuid = data.get("upload_uuid")
    if uid is None or not upload_uuid:
        return

    # Imported lazily: ws_registry pulls the websocket stack; keep the bridge
    # import-light so it can also be used from worker contexts.
    from app.services.ws_registry import broadcast_cloud_status

    await broadcast_cloud_status(
        int(uid),
        str(upload_uuid),
        str(data.get("status", "")),
        int(data.get("chunk_count", 0) or 0),
        str(data.get("error", "") or ""),
    )


async def run_bridge(stop: asyncio.Event) -> None:
    """Long-running subscriber task; exits when *stop* is set."""
    while not stop.is_set():
        if not redis_mod.is_enabled() or redis_mod.client is None:
            logger.info("[CLOUD_WS_BRIDGE] redis unavailable — retrying later")
            await asyncio.sleep(_RESTART_DELAY)
            continue
        try:
            pubsub = redis_mod.client.pubsub()
            await pubsub.subscribe(CHANNEL)
            logger.info("[CLOUD_WS_BRIDGE] subscribed channel=%s", CHANNEL)
            async for message in pubsub.listen():
                if stop.is_set():
                    break
                if message.get("type") != "message":
                    continue
                payload = message.get("data")
                if isinstance(payload, bytes):
                    payload = payload.decode("utf-8", errors="replace")
                await _handle_message(payload)
        except asyncio.CancelledError:
            break
        except Exception as e:  # noqa: BLE001 — keep the bridge alive
            logger.warning("[CLOUD_WS_BRIDGE] subscriber error (restart in {}s): {}", _RESTART_DELAY, e)
            await asyncio.sleep(_RESTART_DELAY)
        finally:
            try:
                await pubsub.aclose()  # type: ignore[possibly-undefined]
            except Exception:  # noqa: BLE001
                pass
    logger.info("[CLOUD_WS_BRIDGE] stopped")
