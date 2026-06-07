"""Backward-compatibility re-export — MinIO client has moved to app.infra.minio."""

from app.infra.minio import (  # noqa: F401
    MinioClient,
    get_minio_client,
    init,
    close,
    ping,
    is_enabled,
)
