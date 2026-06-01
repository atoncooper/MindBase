"""
MinIO / S3 client wrapper — lazy-imported singleton with presigned-URL support
for multipart uploads and video streaming.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Optional
from urllib.parse import urlparse

from loguru import logger

from app.infra.config import config


_MINIO_AVAILABLE: bool | None = None  # tri-state: None = not checked yet
_MINIO_CLIENT: Optional[object] = None  # minio.Minio instance (lazy-imported)


def _check_minio_import() -> bool:
    """Lazy-check whether the minio package is installed.  Cached after first call."""
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
    """Import and return the minio module (raises ImportError if not available)."""
    import minio as _m
    from minio import Minio, S3Error
    return _m, Minio, S3Error


def _endpoint_host(endpoint: str) -> str:
    """Strip scheme from endpoint.  MinIO SDK expects ``host:port``."""
    parsed = urlparse(endpoint)
    return parsed.netloc or endpoint


class MinioClient:
    """Thin wrapper around the MinIO Python SDK.

    Created lazily so modules that import this file do not fail when the
    minio package is absent or MinIO is disabled in config.
    """

    def __init__(self) -> None:
        self._client: Optional[object] = None
        self._initialised = False

    # ------------------------------------------------------------------
    # internal init
    # ------------------------------------------------------------------

    def _ensure_client(self) -> object:  # returns minio.Minio instance
        """Return the underlying Minio SDK client, creating it on first access."""
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

    # ------------------------------------------------------------------
    # properties
    # ------------------------------------------------------------------

    @property
    def enabled(self) -> bool:
        """True when MinIO is enabled in config AND has credentials."""
        return config.minio.enabled and bool(config.minio.access_key.get_secret_value())

    @property
    def bucket(self) -> str:
        return config.minio.bucket

    @property
    def endpoint(self) -> str:
        return _endpoint_host(config.minio.endpoint)

    # ------------------------------------------------------------------
    # bucket management
    # ------------------------------------------------------------------

    async def ensure_bucket(self) -> None:
        """Idempotent bucket creation.  No-op when the bucket already exists."""
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

    # ------------------------------------------------------------------
    # multipart upload helpers
    # ------------------------------------------------------------------

    async def create_multipart_upload(self, object_key: str) -> str:
        """Initiate a multipart upload and return the *upload_id*."""
        self._ensure_client()
        result = await _run_async(
            self._client._create_multipart_upload,
            self.bucket,
            object_key,
            {},
        )
        upload_id = result
        logger.debug(
            "[MINIO] multipart_upload started object_key=%s upload_id=%s",
            object_key, upload_id,
        )
        return upload_id

    async def presigned_upload_part(
        self, object_key: str, upload_id: str, part_number: int,
    ) -> str:
        """Return a presigned PUT URL for a single multipart-upload part.

        *part_number* is 1-indexed (S3 convention).
        """
        self._ensure_client()
        url = await _run_async(
            self._client.presigned_put_object,
            self.bucket,
            object_key,
            expires=timedelta(seconds=config.minio.presign_expire),
            extra_query_params={
                "uploadId": upload_id,
                "partNumber": str(part_number),
            },
        )
        logger.debug(
            "[MINIO] presigned_upload_part object_key=%s part=%d",
            object_key, part_number,
        )
        return url

    async def complete_multipart_upload(
        self, object_key: str, upload_id: str, parts: list[dict],
    ) -> str:
        """Complete a multipart upload.

        *parts* is a list of dicts with ``PartNumber`` (int) and ``ETag`` (str).

        Returns the final object ETag.
        """
        self._ensure_client()
        _Minio = self._client.__class__
        # Build the XML part list expected by S3/MinIO
        converted: list = []
        for p in parts:
            converted.append((p["PartNumber"], p["ETag"]))

        result = await _run_async(
            self._client._complete_multipart_upload,
            self.bucket,
            object_key,
            upload_id,
            converted,
        )
        # result is the XML response body as string; extract ETag if possible
        etag = ""
        if isinstance(result, str):
            # Simple regex-free extraction from XML
            tag_start = result.find("<ETag>")
            tag_end = result.find("</ETag>")
            if tag_start != -1 and tag_end != -1:
                etag = result[tag_start + 6:tag_end].strip('"')
        logger.info(
            "[MINIO] multipart_upload complete object_key=%s etag=%s",
            object_key, etag,
        )
        return etag

    async def abort_multipart_upload(
        self, object_key: str, upload_id: str,
    ) -> None:
        """Abort an in-progress multipart upload, freeing held storage."""
        self._ensure_client()
        try:
            await _run_async(
                self._client._abort_multipart_upload,
                self.bucket,
                object_key,
                upload_id,
            )
            logger.info(
                "[MINIO] multipart_upload aborted object_key=%s upload_id=%s",
                object_key, upload_id,
            )
        except Exception as exc:
            logger.warning(
                "[MINIO] abort_multipart_upload failed object_key=%s err=%s",
                object_key, exc,
            )

    # ------------------------------------------------------------------
    # object access
    # ------------------------------------------------------------------

    async def presigned_get(self, object_key: str) -> str:
        """Return a presigned GET URL (e.g. for video streaming)."""
        self._ensure_client()
        url = await _run_async(
            self._client.presigned_get_object,
            self.bucket,
            object_key,
            expires=timedelta(seconds=config.minio.presign_expire),
        )
        logger.debug("[MINIO] presigned_get object_key=%s", object_key)
        return url

    async def delete_object(self, object_key: str) -> None:
        """Hard-delete an object from the bucket."""
        self._ensure_client()
        try:
            await _run_async(
                self._client.remove_object,
                self.bucket,
                object_key,
            )
            logger.info("[MINIO] deleted object_key=%s", object_key)
        except Exception as exc:
            logger.warning(
                "[MINIO] delete_object failed object_key=%s err=%s",
                object_key, exc,
            )

    async def stat_object(self, object_key: str) -> Optional[dict]:
        """Return object metadata dict, or None if the object does not exist."""
        self._ensure_client()
        _, _, S3Error = _get_minio_sdk()
        try:
            stat = await _run_async(
                self._client.stat_object,
                self.bucket,
                object_key,
            )
            return {
                "size": stat.size,
                "etag": stat.etag,
                "content_type": getattr(stat, "content_type", None),
                "last_modified": (
                    stat.last_modified.isoformat() if stat.last_modified else None
                ),
            }
        except S3Error as exc:
            if exc.code == "NoSuchKey":
                return None
            raise


# ------------------------------------------------------------------
# async helper
# ------------------------------------------------------------------


import asyncio


async def _run_async(func, *args, **kwargs):
    """Run a synchronous MinIO SDK call in the default executor."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: func(*args, **kwargs))


# ------------------------------------------------------------------
# module-level singleton
# ------------------------------------------------------------------

_client: Optional[MinioClient] = None


def get_minio_client() -> MinioClient:
    global _client
    if _client is None:
        _client = MinioClient()
    return _client
