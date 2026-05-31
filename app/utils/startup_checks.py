"""
Startup health checks — verify all enabled infrastructure is reachable.

Fail-fast: if a required component is enabled but unhealthy, raise RuntimeError
to prevent the application from starting in a degraded state.

Usage (in main.py lifespan):
    from app.utils.startup_checks import run_startup_checks
    await run_startup_checks()
"""

from __future__ import annotations

from loguru import logger


class StartupCheckError(RuntimeError):
    """Raised when an enabled infrastructure component fails its health check."""


async def run_startup_checks() -> None:
    """Run health checks for all enabled infrastructure components.

    Raises StartupCheckError if any enabled component is unreachable.
    """
    errors: list[str] = []

    # 1. MySQL — always required
    try:
        await _check_mysql()
        logger.info("[STARTUP] MySQL: OK")
    except Exception as e:
        errors.append(f"MySQL: {e}")

    # 2. ChromaDB — required if enabled
    from app.infra.config import config as _cfg
    if getattr(_cfg.chroma, 'enabled', True):
        try:
            _check_chroma()
            logger.info("[STARTUP] ChromaDB: OK")
        except Exception as e:
            errors.append(f"ChromaDB: {e}")

    # 3. Milvus — required if enabled
    if _cfg.milvus.enabled:
        try:
            from app.infra.milvus import ping as milvus_ping, init as milvus_init
            await milvus_init()
            result = await milvus_ping()
            if not result["ok"]:
                raise StartupCheckError(result.get("error", "unknown"))
            logger.info("[STARTUP] Milvus: OK (latency=%dms)", result["latency_ms"])
        except Exception as e:
            errors.append(f"Milvus: {e}")

    # 4. MongoDB — required if enabled
    if _cfg.mongo.enabled:
        try:
            from app.infra.mongo import init as mongo_init, ping as mongo_ping
            await mongo_init()
            result = await mongo_ping()
            if not result["ok"]:
                raise StartupCheckError(result.get("error", "unknown"))
            logger.info("[STARTUP] MongoDB: OK (latency=%dms)", result["latency_ms"])
        except Exception as e:
            errors.append(f"MongoDB: {e}")

    # 5. Redis — required if enabled
    if _cfg.redis.enabled:
        try:
            from app.infra.redis import init as redis_init, ping as redis_ping
            await redis_init()
            result = await redis_ping()
            if not result["ok"]:
                raise StartupCheckError(result.get("error", "unknown"))
            logger.info("[STARTUP] Redis: OK (latency=%dms)", result["latency_ms"])
        except Exception as e:
            errors.append(f"Redis: {e}")

    if errors:
        logger.warning("[STARTUP] Some services unavailable (app will start anyway):\n  %s",
                       "\n  ".join(errors))

    logger.info("[STARTUP] Health checks complete")


# ── Per-component checks ────────────────────────────────────────────


async def _check_mysql() -> None:
    """Verify MySQL connection with SELECT 1."""
    from app.database import async_session_factory
    from sqlalchemy import text

    async with async_session_factory() as db:
        result = await db.execute(text("SELECT 1"))
        row = result.scalar()
        if row != 1:
            raise StartupCheckError("SELECT 1 returned unexpected value")


def _check_chroma() -> None:
    """Verify ChromaDB persist directory is accessible."""
    import os
    from app.infra.config import config

    persist_dir = config.chroma.persist_directory
    os.makedirs(persist_dir, exist_ok=True)

    if not os.access(persist_dir, os.R_OK | os.W_OK):
        raise StartupCheckError(f"ChromaDB persist directory not readable/writable: {persist_dir}")
