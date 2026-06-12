"""
MinIO bucket-event listener — subscribes to Redis pub/sub channel for
MinIO notifications and reacts to completion events (e.g. when a
multipart upload finishes but the frontend never called complete_upload).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

from loguru import logger

from app.database import get_db_context
from app.infra.redis import is_enabled as redis_enabled, pubsub
from app.repository.cloud.file_repository import get_cloud_file_repository

# ---------------------------------------------------------------------------
# Channel
# ---------------------------------------------------------------------------

CHANNEL: str = "minio:events:clouddrive"


# ---------------------------------------------------------------------------
# Event listener
# ---------------------------------------------------------------------------
async def start_minio_event_listener() -> None:
    """Subscribe to Redis channel ``minio:events:clouddrive`` and process
    MinIO bucket events.

    This function runs forever and should be launched as a background task
    during application startup.
    """
    if not redis_enabled():
        logger.info("[CLOUD_EVENTS] listener skipped — Redis disabled")
        return

    logger.info("[CLOUD_EVENTS] starting minio-event listener channel={}", CHANNEL)

    try:
        ps = pubsub()
        await ps.subscribe(CHANNEL)

        async for message in ps.listen():
            if message is None:
                continue
            if message.get("type") != "message":
                continue

            data = message.get("data", "")
            if isinstance(data, bytes):
                data = data.decode("utf-8", errors="replace")

            try:
                event: dict[str, Any] = json.loads(data)
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    "[CLOUD_EVENTS] received non-JSON message on {}", CHANNEL
                )
                continue

            await _handle_minio_event(event)

    except asyncio.CancelledError:
        logger.info("[CLOUD_EVENTS] listener cancelled")
    except Exception:
        logger.exception("[CLOUD_EVENTS] listener crashed")


# ---------------------------------------------------------------------------
# Event dispatch
# ---------------------------------------------------------------------------
async def _handle_minio_event(event: dict[str, Any]) -> None:
    """Route a MinIO event to the appropriate handler."""
    event_name = event.get("EventName", "")
    records: list[dict[str, Any]] = event.get("Records", [event])

    if not event_name and records:
        # MinIO webhook format: Records[0].eventName
        event_name = records[0].get("eventName", "")

    logger.debug("[CLOUD_EVENTS] received event={}", event_name)

    if (
        "CompleteMultipartUpload" in event_name
        or "s3:ObjectCreated:CompleteMultipartUpload" in event_name
    ):
        for record in records:
            s3_info = record.get("s3", {})
            bucket_name = s3_info.get("bucket", {}).get("name", "")
            object_info = s3_info.get("object", {})
            object_key = object_info.get("key", "")
            if isinstance(object_key, bytes):
                object_key = object_key.decode("utf-8", errors="replace")

            if bucket_name and object_key:
                await _on_complete_multipart(object_key)
    else:
        logger.debug(
            "[CLOUD_EVENTS] unhandled event type event={}",
            event_name,
        )


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------
async def _on_complete_multipart(object_key: str) -> None:
    """Handle a completed multipart upload event from MinIO.

    If the corresponding CloudFile still shows *uploading* status (the
    frontend never called complete_upload), mark it as *completed* and
    kick off the ASR + vector pipeline in the background.

    Object key format: ``{uid}/{upload_uuid}/video.mp4``
    """
    upload_uuid = _parse_upload_uuid(object_key)
    if upload_uuid is None:
        logger.warning(
            "[CLOUD_EVENTS] cannot parse upload_uuid from object_key={}",
            object_key,
        )
        return

    logger.info(
        "[CLOUD_EVENTS] complete_multipart object_key={} upload_uuid={}",
        object_key,
        upload_uuid,
    )

    try:
        async with get_db_context() as db:
            file_repo = get_cloud_file_repository()
            # update_upload_completed is uid-agnostic (WHERE upload_uuid = ?)
            await file_repo.update_upload_completed(upload_uuid, "", db)

            logger.info(
                "[CLOUD_EVENTS] marked upload_uuid={} as completed via event",
                upload_uuid,
            )

        # Fire-and-forget ASR + vector pipeline
        # (same pattern as CloudUploadService._trigger_pipeline)
        asyncio.create_task(_trigger_pipeline_for(upload_uuid))

    except Exception:
        logger.exception(
            "[CLOUD_EVENTS] failed to handle complete event upload_uuid={}",
            upload_uuid,
        )


async def _trigger_pipeline_for(upload_uuid: str) -> None:
    """Background task: trigger ASR + vector pipeline for an upload."""
    try:
        logger.info(
            "[CLOUD_EVENTS] pipeline triggered upload_uuid={}",
            upload_uuid,
        )
        # TODO: wire up actual ASR + vectorisation when those modules
        # gain cloud-awareness.
        # from app.services.asr import asr_service
        # await asr_service.process_cloud_file(upload_uuid)
    except Exception:
        logger.exception(
            "[CLOUD_EVENTS] pipeline failed upload_uuid={}",
            upload_uuid,
        )


def _parse_upload_uuid(object_key: str) -> Optional[str]:
    """Extract *upload_uuid* from an object key like ``123/abc-def/video.mp4``."""
    parts = object_key.strip("/").split("/")
    if len(parts) >= 2:
        # parts[0] = uid, parts[1] = upload_uuid
        candidate = parts[1]
        if len(candidate) == 36:  # standard UUID length
            return candidate
    return None
