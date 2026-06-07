"""
MinIO / S3 client wrapper — follows the same lifecycle pattern as mongo.py / redis.py.

Usage:
    from app.infra.minio import init, close, ping, get_minio_client

    # startup
    await init()

    # runtime
    client = get_minio_client()
    url = await client.presigned_get("object-key")

    # shutdown
    await close()
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Optional
from urllib.parse import urlparse

from loguru import logger

from app.infra.config import config


def is_enabled() -> bool:
    return config.minio.enabled


# ---------------------------------------------------------------------------
# lifecycle
# ---------------------------------------------------------------------------


async def init() -> None:
    """Pre-warm the MinIO client connection and create the configured bucket."""
    if not is_enabled():
        logger.info("[MINIO] disabled, skipping init")
        return

    client = get_minio_client()
    try:
        await client.ensure_bucket()
        logger.info("[MINIO] init OK (endpoint=%s bucket=%s)", client.endpoint, client.bucket)
    except Exception as e:
        logger.warning("[MINIO] init failed (continuing): %s", e)


async def close() -> None:
    """Release MinIO client resources.  The SDK uses urllib3 connection
    pooling internally; explicit close is optional but recommended."""
    if not is_enabled():
        return
    # The MinIO SDK does not expose a client-level close() — connection
    # pools are managed by urllib3 internally and cleaned up at GC.
    logger.info("[MINIO] closed")


async def ping() -> dict:
    """Health check: verify bucket exists and is reachable."""
    if not is_enabled():
        return {"ok": False, "error": "disabled"}

    import time
    start = time.time()
    try:
        client = get_minio_client()
        _ = client._ensure_client()
        found = await _run_async(client._client.bucket_exists, client.bucket)
        latency_ms = int((time.time() - start) * 1000)
        return {
            "ok": found,
            "latency_ms": latency_ms,
            "error": None if found else "bucket not found",
        }
    except Exception as e:
        return {"ok": False, "latency_ms": int((time.time() - start) * 1000), "error": str(e)}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


async def _run_async(func, *args, **kwargs):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: func(*args, **kwargs))


_MINIO_AVAILABLE: bool | None = None


def _check_minio_import() -> bool:
    global _MINIO_AVAILABLE
    if _MINIO_AVAILABLE is None:
        try:
            import minio  # noqa: F401
            _MINIO_AVAILABLE = True
        except ImportError:
            _MINIO_AVAILABLE = False
            logger.warning("[MINIO] minio-py not installed; MinioClient disabled")
    return _MINIO_AVAILABLE


def _get_minio_sdk():
    import minio as _m
    from minio import Minio, S3Error
    return _m, Minio, S3Error


def _endpoint_host(endpoint: str) -> str:
    parsed = urlparse(endpoint)
    return parsed.netloc or endpoint


# ---------------------------------------------------------------------------
# MinioClient
# ---------------------------------------------------------------------------


class MinioClient:
    """Thin wrapper around the MinIO Python SDK.

    Created as a module-level singleton via ``get_minio_client()``.
    """

    def __init__(self) -> None:
        self._client: Optional[object] = None

    def _ensure_client(self) -> object:
        if self._client is not None:
            return self._client

        if not _check_minio_import():
            raise RuntimeError("[MINIO] minio-py package is not installed")

        _, Minio, _ = _get_minio_sdk()

        self._client = Minio(
            endpoint=_endpoint_host(config.minio.endpoint),
            access_key=config.minio.access_key.get_secret_value(),
            secret_key=config.minio.secret_key.get_secret_value(),
            secure=config.minio.secure,
            region=config.minio.region,
        )
        logger.info(
            "[MINIO] client created endpoint=%s bucket=%s secure=%s",
            _endpoint_host(config.minio.endpoint),
            config.minio.bucket,
            config.minio.secure,
        )
        return self._client

    def _public_url(self, internal_url: str) -> str:
        public = config.minio.public_endpoint.rstrip("/")
        if not public:
            return internal_url
        internal = config.minio.endpoint.rstrip("/")
        if not internal_url.startswith(internal):
            return internal_url
        return public + internal_url[len(internal):]

    @property
    def enabled(self) -> bool:
        return config.minio.enabled and bool(config.minio.access_key.get_secret_value())

    @property
    def bucket(self) -> str:
        return config.minio.bucket

    @property
    def endpoint(self) -> str:
        return _endpoint_host(config.minio.endpoint)

    # ── bucket ────────────────────────────────────────────────

    async def ensure_bucket(self) -> None:
        if not self.enabled:
            logger.warning("[MINIO] ensure_bucket skipped — minio disabled")
            return
        client = self._ensure_client()
        found = await _run_async(client.bucket_exists, self.bucket)
        if found:
            logger.debug("[MINIO] bucket exists bucket=%s", self.bucket)
            return
        await _run_async(client.make_bucket, self.bucket)
        logger.info("[MINIO] created bucket=%s", self.bucket)

    # ── multipart upload ──────────────────────────────────────

    async def create_multipart_upload(self, object_key: str) -> str:
        self._ensure_client()
        result = await _run_async(
            self._client._create_multipart_upload, self.bucket, object_key, {},
        )
        return result

    async def presigned_upload_part(
        self, object_key: str, upload_id: str, part_number: int,
    ) -> str:
        self._ensure_client()
        url = await _run_async(
            self._client.get_presigned_url,
            "PUT", self.bucket, object_key,
            expires=timedelta(seconds=config.minio.presign_expire),
            extra_query_params={"uploadId": upload_id, "partNumber": str(part_number)},
        )
        return self._public_url(url)

    async def complete_multipart_upload(
        self, object_key: str, upload_id: str, parts: list[dict],
    ) -> str:
        from collections import namedtuple
        self._ensure_client()
        _Part = namedtuple("_Part", ["part_number", "etag"])
        converted = [_Part(p["PartNumber"], p["ETag"]) for p in parts]
        result = await _run_async(
            self._client._complete_multipart_upload,
            self.bucket, object_key, upload_id, converted,
        )
        etag = ""
        if isinstance(result, str):
            tag_start = result.find("<ETag>")
            tag_end = result.find("</ETag>")
            if tag_start != -1 and tag_end != -1:
                etag = result[tag_start + 6:tag_end].strip('"')
        logger.info("[MINIO] multipart_upload complete object_key=%s etag=%s", object_key, etag)
        return etag

    async def abort_multipart_upload(self, object_key: str, upload_id: str) -> None:
        self._ensure_client()
        try:
            await _run_async(
                self._client._abort_multipart_upload,
                self.bucket, object_key, upload_id,
            )
        except Exception as exc:
            logger.warning("[MINIO] abort_multipart_upload failed object_key=%s err=%s", object_key, exc)

    # ── object access ─────────────────────────────────────────

    async def presigned_get(self, object_key: str) -> str:
        self._ensure_client()
        url = await _run_async(
            self._client.presigned_get_object,
            self.bucket, object_key,
            expires=timedelta(seconds=config.minio.presign_expire),
        )
        return self._public_url(url)

    async def delete_object(self, object_key: str) -> None:
        self._ensure_client()
        await _run_async(self._client.remove_object, self.bucket, object_key)
        logger.info("[MINIO] deleted object_key=%s", object_key)

    async def stat_object(self, object_key: str) -> Optional[dict]:
        self._ensure_client()
        _, _, S3Error = _get_minio_sdk()
        try:
            stat = await _run_async(self._client.stat_object, self.bucket, object_key)
            return {
                "size": stat.size,
                "etag": stat.etag,
                "content_type": getattr(stat, "content_type", None),
                "last_modified": stat.last_modified.isoformat() if stat.last_modified else None,
            }
        except S3Error as exc:
            if exc.code == "NoSuchKey":
                return None
            raise

    async def get_object(self, object_key: str) -> bytes:
        self._ensure_client()
        _, _, S3Error = _get_minio_sdk()
        try:
            response = await _run_async(self._client.get_object, self.bucket, object_key)
            data = await _run_async(response.read)
            await _run_async(response.close)
            await _run_async(response.release_conn)
            return data
        except S3Error as exc:
            if exc.code == "NoSuchKey":
                raise FileNotFoundError(f"Object not found: {object_key}") from exc
            raise


# ---------------------------------------------------------------------------
# module-level singleton
# ---------------------------------------------------------------------------

_client: Optional[MinioClient] = None


def get_minio_client() -> MinioClient:
    global _client
    if _client is None:
        _client = MinioClient()
    return _client
