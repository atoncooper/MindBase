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

Note on PyMilvusDeprecationWarning:
    pymilvus 2.5+ flags the ORM-style API (``connections.connect``,
    ``Collection(...)``, ``utility.*``) as deprecated in favor of
    ``MilvusClient``. Migrating is a cross-cutting change (this file plus
    ``app/repository/vector_store_milvus.py`` and the ``cloud`` /
    ``knowledge`` routers all share the same default connection), so for
    now we suppress the warning at the call sites instead of half-migrating
    a single file. Track the full migration as a separate task.
"""

from __future__ import annotations

import contextlib
import time
import warnings
from typing import Any

from loguru import logger

from app.infra.config import config


@contextlib.contextmanager
def _suppress_pymilvus_deprecation():
    """Filter PyMilvusDeprecationWarning only; other warnings still surface.

    The warning class is imported lazily so this module still works when
    pymilvus is missing or vendored.
    """

    with warnings.catch_warnings():
        try:
            from pymilvus.exceptions import PyMilvusDeprecationWarning

            warnings.filterwarnings("ignore", category=PyMilvusDeprecationWarning)
        except ImportError:
            # Older / vendored pymilvus may put the class elsewhere — fall
            # back to a message-based filter so we still squelch the noise.
            warnings.filterwarnings("ignore", message=r".*ORM-style PyMilvus API.*")
        yield


def is_enabled() -> bool:
    return config.milvus.enabled


async def init() -> None:
    """Connect to Milvus.  No-op when disabled."""
    if not is_enabled():
        logger.info("[MILVUS] disabled, skipping init")
        return

    from pymilvus import connections

    try:
        with _suppress_pymilvus_deprecation():
            connections.connect(
                alias="default",
                uri=config.milvus.uri,
                token=config.milvus.token or None,
            )
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
    """Disconnect from Milvus."""
    if not is_enabled():
        return

    from pymilvus import connections

    try:
        with _suppress_pymilvus_deprecation():
            connections.disconnect("default")
        logger.info("[MILVUS] closed")
    except Exception as e:
        logger.warning("[MILVUS] close error: error_type={}", type(e).__name__)


async def ping() -> dict[str, Any]:
    """Health check with round-trip latency."""
    if not is_enabled():
        return {"ok": False, "latency_ms": 0, "error": "disabled"}

    from pymilvus import connections

    try:
        with _suppress_pymilvus_deprecation():
            if not connections.has_connection("default"):
                return {"ok": False, "latency_ms": 0, "error": "not connected"}
    except Exception:
        pass

    start = time.time()
    try:
        from pymilvus import utility

        with _suppress_pymilvus_deprecation():
            utility.list_collections()
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
