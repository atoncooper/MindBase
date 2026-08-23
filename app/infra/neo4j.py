"""Async Neo4j client via the official ``neo4j`` driver (KG feature).

Lazy initialisation: call :func:`init` during application startup.
If ``kg.enabled`` is false — or the connection fails — the module stays in a
disabled state and callers degrade gracefully (mirrors ``infra/mongo.py``).

Usage:
    from app.infra.neo4j import init, close, is_enabled, get_driver

    await init()          # startup
    driver = get_driver() # None when disabled/unreachable
    await close()         # shutdown

Sessions are short-lived per operation:
    async with session(database="neo4j") as s:
        rows = await run(s, "MATCH (e:Entity) RETURN e LIMIT $n", n=10)
"""

from __future__ import annotations

import time
from typing import Any

from loguru import logger

from app.infra.config import config

# Module-level state — populated by init()
_driver: Any | None = None


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


async def init() -> None:
    """Connect to Neo4j and verify connectivity.

    No-op when ``kg.enabled`` is false.  Connection failures are logged as
    warnings (Neo4j is treated as an optional dependency — KG degrades).
    """
    global _driver

    if not config.kg.enabled:
        logger.info("[NEO4J] disabled (kg.enabled=false), skipping init")
        return

    from neo4j import AsyncGraphDatabase

    # 空 uri（YAML 默认）回退本地默认端口，便于非 Docker 直连开发
    uri = config.kg.uri.strip() or "bolt://localhost:7687"
    password = config.kg.password.get_secret_value()
    try:
        _driver = AsyncGraphDatabase.driver(
            uri,
            auth=(config.kg.username, password),
            connection_timeout=10.0,
            max_connection_pool_size=20,
        )
        await _driver.verify_connectivity()
    except Exception as exc:
        logger.warning(
            "[NEO4J] init failed (KG features degraded): {} — uri={}",
            exc,
            uri,
        )
        try:
            if _driver is not None:
                await _driver.close()
        except Exception:
            pass
        _driver = None
        return

    await ensure_constraints()
    latency = await ping()
    logger.info(
        "[NEO4J] connected: uri={} db={} latency={}ms",
        uri,
        config.kg.database,
        latency.get("latency_ms"),
    )


async def ensure_constraints() -> None:
    """Idempotently create uniqueness constraints for the KG schema."""
    statements = [
        "CREATE CONSTRAINT kg_entity_eid IF NOT EXISTS "
        "FOR (e:Entity) REQUIRE e.eid IS UNIQUE",
        "CREATE CONSTRAINT kg_entity_name IF NOT EXISTS "
        "FOR (e:Entity) REQUIRE e.name_lower IS UNIQUE",
        "CREATE CONSTRAINT kg_video_bvid IF NOT EXISTS "
        "FOR (v:Video) REQUIRE v.bvid IS UNIQUE",
    ]
    async with session() as s:
        for stmt in statements:
            try:
                await run(s, stmt)
            except Exception as exc:
                logger.warning("[NEO4J] constraint creation failed: {}", exc)


async def close() -> None:
    """Close the driver and release the connection pool."""
    global _driver
    if _driver is not None:
        try:
            await _driver.close()
        except Exception as exc:
            logger.debug("[NEO4J] close error (ignored): {}", exc)
        _driver = None
    logger.info("[NEO4J] closed")


async def ping() -> dict[str, Any]:
    """Return connection health with round-trip latency in milliseconds."""
    start = time.time()
    if _driver is None:
        return {"ok": False, "latency_ms": 0, "error": "not initialized"}
    try:
        async with _driver.session(database=config.kg.database) as s:
            await s.run("RETURN 1")
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


def get_driver() -> Any | None:
    """Return the raw AsyncDriver handle, or None if disabled/unreachable."""
    return _driver


def is_enabled() -> bool:
    """Return True if Neo4j is enabled and connected."""
    return _driver is not None


def session(database: str | None = None) -> Any:
    """Return an async session context manager.

    Raises RuntimeError when the driver is not initialized — callers that
    need soft-failure semantics should check :func:`is_enabled` first.
    """
    if _driver is None:
        raise RuntimeError("[NEO4J] not initialized or disabled")
    return _driver.session(database=database or config.kg.database)


async def run(s: Any, cypher: str, **params: Any) -> list[dict[str, Any]]:
    """Execute a cypher statement on an open session; return rows as dicts."""
    result = await s.run(cypher, **params)
    return await result.data()
