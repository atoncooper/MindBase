"""
Milvus connection health — follows same lifecycle pattern as mongo.py / redis.py.

Uses the modern ``MilvusClient`` function-style API (PyMilvus 2.4+).
The legacy ORM-style ``connections`` / ``utility`` API is deprecated and
will be removed in PyMilvus 3.1.

This module owns a singleton ``MilvusClient`` used purely for health
checks (``ping``).  ``MilvusVectorStore`` instances create their own
clients independently — both are lightweight gRPC channels.

Usage:
    from app.infra.milvus import init, close, ping, is_enabled

    # startup
    await init()

    # health
    result = await ping()  # {"ok": True, "latency_ms": 3, "error": None}

    # shutdown
    await close()
"""

from __future__ import annotations

import time
from typing import Any

from loguru import logger

from app.infra.config import config

# Singleton health-check client — populated by init(), cleared by close().
_client: Any = None


def is_enabled() -> bool:
    return config.milvus.enabled


async def init() -> None:
    """Create the health-check MilvusClient.  No-op when disabled."""
    global _client
    if not is_enabled():
        logger.info("[MILVUS] disabled, skipping init")
        return

    from pymilvus import MilvusClient

    try:
        kwargs: dict[str, Any] = {"uri": config.milvus.uri}
        if config.milvus.token:
            kwargs["token"] = config.milvus.token
        _client = MilvusClient(**kwargs)
    except Exception as e:
        logger.warning(
            "[MILVUS] init failed (continuing): error_type={} uri={} msg={}",
            type(e).__name__,
            config.milvus.uri,
            str(e),
        )
        return

    result = await ping()
    if result["ok"]:
        logger.info(
            "[MILVUS] connected: uri_configured={}, db={}, latency={}ms",
            bool(config.milvus.uri),
            config.milvus.db_name,
            result["latency_ms"],
        )
    else:
        logger.warning(
            "[MILVUS] ping failed after connect: error_type={}", result["error"]
        )


async def close() -> None:
    """Close the health-check client."""
    global _client
    if _client is None:
        return
    try:
        _client.close()
        logger.info("[MILVUS] closed")
    except Exception as e:
        logger.warning("[MILVUS] close error: error_type={}", type(e).__name__)
    finally:
        _client = None


async def ping() -> dict[str, Any]:
    """Health check with round-trip latency."""
    if not is_enabled():
        return {"ok": False, "latency_ms": 0, "error": "disabled"}
    if _client is None:
        return {"ok": False, "latency_ms": 0, "error": "not initialized"}

    start = time.time()
    try:
        _client.list_collections()
        return {
            "ok": True,
            "latency_ms": int((time.time() - start) * 1000),
            "error": None,
        }
    except Exception as exc:
        return {
            "ok": False,
            "latency_ms": int((time.time() - start) * 1000),
            "error": type(exc).__name__,
        }
