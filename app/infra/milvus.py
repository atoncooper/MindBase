"""
Milvus connection management — follows same lifecycle pattern as mongo.py / redis.py.

Lazy initialisation: call ``init()`` during application startup.
If ``milvus.enabled`` is false the module skips connection entirely.

Usage:
    from app.infra.milvus import init, close, ping, is_enabled

    # startup
    await init()

    # query
    from pymilvus import Collection
    col = Collection("bilibili_videos")
    col.query(expr="bvid == 'BV1xx'")

    # shutdown
    await close()
"""

from __future__ import annotations

import time
from typing import Any

from loguru import logger

from app.infra.config import config


def is_enabled() -> bool:
    return config.milvus.enabled


async def init() -> None:
    """Connect to Milvus.  No-op when disabled."""
    if not is_enabled():
        logger.info("[MILVUS] disabled, skipping init")
        return

    from pymilvus import connections

    try:
        connections.connect(
            alias="default",
            uri=config.milvus.uri,
            token=config.milvus.token or None,
        )
    except Exception as e:
        logger.warning("[MILVUS] init failed (continuing): %s", e)
        return

    result = await ping()
    if result["ok"]:
        logger.info(
            "[MILVUS] connected: uri=%s, db=%s, latency=%dms",
            config.milvus.uri,
            config.milvus.db_name,
            result["latency_ms"],
        )
    else:
        logger.warning("[MILVUS] ping failed after connect: %s", result["error"])


async def close() -> None:
    """Disconnect from Milvus."""
    if not is_enabled():
        return

    from pymilvus import connections

    try:
        connections.disconnect("default")
        logger.info("[MILVUS] closed")
    except Exception as e:
        logger.warning("[MILVUS] close error: %s", e)


async def ping() -> dict[str, Any]:
    """Health check with round-trip latency."""
    if not is_enabled():
        return {"ok": False, "latency_ms": 0, "error": "disabled"}

    from pymilvus import connections

    try:
        if not connections.has_connection("default"):
            return {"ok": False, "latency_ms": 0, "error": "not connected"}
    except Exception:
        pass

    start = time.time()
    try:
        from pymilvus import utility
        utility.list_collections()
        return {"ok": True, "latency_ms": int((time.time() - start) * 1000), "error": None}
    except Exception as exc:
        return {"ok": False, "latency_ms": int((time.time() - start) * 1000), "error": str(exc)}
