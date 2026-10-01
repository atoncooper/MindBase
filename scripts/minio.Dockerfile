# ====== MinIO server, vendored under our own namespace ======
# Upstream removed community MinIO from every distribution channel: the
# Docker Hub repo (minio/minio) was deleted, dl.min.io binaries return 410,
# and github.com/minio/minio was archived (2026-04) as source-only. This
# image vendors the last upstream release that still published prebuilt
# linux binaries as GitHub release assets, so fresh hosts can always pull
# a working server. MinIO is AGPL-3.0: unmodified upstream binary, source
# pinned to the same release tag.
ARG MINIO_RELEASE=RELEASE.2025-09-07T16-13-09Z

FROM alpine:3.21
ARG MINIO_RELEASE
# curl stays installed: the compose healthcheck calls the MinIO health endpoint.
RUN apk add --no-cache curl && \
    curl -fsSL -o /usr/bin/minio \
      "https://github.com/minio/minio/releases/download/${MINIO_RELEASE}/minio.linux-amd64.${MINIO_RELEASE}" && \
    chmod 0755 /usr/bin/minio

EXPOSE 9000 9001
# Root by default, matching the previous official image so the named /data
# volume gets usable ownership on first mount.
ENTRYPOINT ["/usr/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]
