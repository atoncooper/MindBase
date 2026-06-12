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

    # 2. Milvus — soft check (warn only; init() already handles graceful degradation)
    from app.infra.config import config as _cfg

    if _cfg.milvus.enabled:
        try:
            from app.infra.milvus import ping as milvus_ping, init as milvus_init

            await milvus_init()
            result = await milvus_ping()
            if not result["ok"]:
                logger.warning(
                    "[STARTUP] Milvus: not connected (continuing without vector store)"
                )
            else:
                logger.info("[STARTUP] Milvus: OK (latency={}ms)", result["latency_ms"])
                # Check cloud file consistency after Milvus is confirmed OK
                await _check_cloud_consistency()
        except Exception as e:
            logger.warning("[STARTUP] Milvus: check failed (continuing): {}", e)

    # 4. MongoDB — required if enabled
    if _cfg.mongo.enabled:
        try:
            from app.infra.mongo import init as mongo_init, ping as mongo_ping

            await mongo_init()
            result = await mongo_ping()
            if not result["ok"]:
                raise StartupCheckError(result.get("error", "unknown"))
            logger.info("[STARTUP] MongoDB: OK (latency={}ms)", result["latency_ms"])
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
            logger.info("[STARTUP] Redis: OK (latency={}ms)", result["latency_ms"])
        except Exception as e:
            errors.append(f"Redis: {e}")

    # 6. Time drift check (soft, network-dependent)
    await _check_time_drift()

    if errors:
        msg = "Startup checks failed:\n  " + "\n  ".join(errors)
        logger.error(f"[STARTUP] {msg}")
        raise StartupCheckError(msg)

    logger.info("[STARTUP] All health checks passed")


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


async def _check_time_drift() -> None:
    """Warn if system clock drifts by more than 5 seconds from real UTC.

    Uses HTTP Date header (lightweight, no NTP client dependency).
    Falls back silently if network is unavailable.
    """
    import httpx
    from datetime import datetime, timezone

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get("https://www.googleapis.com/discovery/v1/apis")
            server_date = resp.headers.get("date", "")
            if not server_date:
                logger.warning("[STARTUP] Time drift check skipped (no Date header)")
                return

            from email.utils import parsedate_to_datetime

            server_dt = parsedate_to_datetime(server_date).replace(tzinfo=timezone.utc)
            local_dt = datetime.now(timezone.utc)
            drift = abs((local_dt - server_dt).total_seconds())

            if drift > 5:
                logger.warning(
                    "[STARTUP] System clock drift detected: %.1fs from Google. "
                    "Consider enabling NTP (timedatectl set-ntp true).",
                    drift,
                )
            else:
                logger.info("[STARTUP] Time drift: OK (%.1fs)", drift)
    except Exception:
        logger.debug("[STARTUP] Time drift check skipped (network unavailable)")


async def _check_cloud_consistency() -> None:
    """Check if cloud_files marked 'done' have actual vectors in Milvus cloud_drive.

    Warns (does not auto-fix) if inconsistencies are found.
    Use test/check_cloud_consistency.py --repair to fix.
    """
    try:
        from app.database import async_session_factory
        from app.models import CloudFile
        from app.services.rag import get_rag_service
        from sqlalchemy import select

        rag = get_rag_service()
        if rag.cloud_backend is None:
            return

        async with async_session_factory() as db:
            result = await db.execute(
                select(
                    CloudFile.upload_uuid,
                    CloudFile.vector_status,
                    CloudFile.vector_chunk_count,
                ).where(CloudFile.vector_status == "done")
            )
            done_rows = result.fetchall()

        if not done_rows:
            return

        # Run count_by_upload_uuid checks concurrently
        import asyncio as _asyncio
        from concurrent.futures import ThreadPoolExecutor

        loop = _asyncio.get_running_loop()

        def _count(uuid: str) -> int:
            return rag.cloud_backend.count_by_upload_uuid(uuid)

        with ThreadPoolExecutor(max_workers=min(len(done_rows), 10)) as pool:
            tasks = [loop.run_in_executor(pool, _count, row[0]) for row in done_rows]
            results = await _asyncio.gather(*tasks)

        stale_count = sum(1 for r in results if r == 0)

        if stale_count > 0:
            logger.warning(
                "[STARTUP] Cloud consistency: {}/{} files marked 'done' have 0 vectors in Milvus. "
                "Run: python test/check_cloud_consistency.py --repair",
                stale_count,
                len(done_rows),
            )
        else:
            logger.info(
                "[STARTUP] Cloud consistency: OK ({} files, all present in Milvus)",
                len(done_rows),
            )
    except Exception:
        logger.warning("[STARTUP] Cloud consistency check skipped (DB not ready yet)")
