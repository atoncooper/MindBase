# ====== MinIO server, vendored under our own namespace ======
# Upstream removed community MinIO from every distribution channel: the
# Docker Hub repo (minio/minio) was deleted, dl.min.io binaries return 410,
# and github.com/minio/minio was archived (2026-04) as source-only. This
# image vendors the last upstream release that still published prebuilt
# linux binaries as GitHub release assets, so fresh hosts can always pull
# a working server. MinIO is AGPL-3.0: unmodified upstream binary, source
# pinned to the same release tag.
#
# Rebuild cost: the binary (~120 MB) is downloaded from GitHub only on the
# FIRST build. BuildKit keeps it in a cache mount (/var/cache/minio), so a
# later `docker compose build` / `up -d --build` reuses the cached file
# instead of downloading again. The cache survives image rebuilds and
# `docker image prune`; only `docker builder prune` (or a different
# builder/host) forces one fresh download. Requires BuildKit (Docker 23+ /
# Compose v2 default). `docker compose up -d --no-build` skips building this
# image entirely.
ARG MINIO_RELEASE=RELEASE.2025-09-07T16-13-09Z

FROM alpine:3.21
ARG MINIO_RELEASE

# Build (this image is NOT in the default compose build graph; one-off command):
#   docker build -t atoncooper/mind-base-minio:latest -f scripts/minio.Dockerfile scripts
#
# Optional download overrides for restricted networks:
#   docker build -t atoncooper/mind-base-minio:latest -f scripts/minio.Dockerfile scripts \
#     --build-arg HTTPS_PROXY=http://host.docker.internal:10808
#   # or a mirror / pre-downloaded HTTP endpoint:
#   ... --build-arg MINIO_BINARY_BASE=https://mirror.example/minio
#   # empty MINIO_BINARY_MIRROR disables the fallback below
# GitHub release downloads are frequently reset by middleboxes ("curl: (35) TLS
# connect error ... unexpected eof"), so a mirror is tried after the primary.
ARG MINIO_BINARY_BASE=https://github.com/minio/minio/releases/download
ARG MINIO_BINARY_MIRROR=https://ghfast.top/https://github.com/minio/minio/releases/download
ARG HTTP_PROXY
ARG HTTPS_PROXY

# curl stays installed: the compose healthcheck calls the MinIO health endpoint.
RUN apk add --no-cache curl

# Download at most once per builder: the cache mount persists the release
# tarball across image rebuilds, and the copy below only touches the cache.
# Sources are tried in order (primary, then mirror); an empty mirror is skipped.
RUN --mount=type=cache,target=/var/cache/minio \
    set -eux; \
    binary="/var/cache/minio/minio.linux-amd64.${MINIO_RELEASE}"; \
    if [ ! -s "$binary" ]; then \
        ok=0; \
        for base in "$MINIO_BINARY_BASE" "$MINIO_BINARY_MIRROR"; do \
            [ -n "$base" ] || continue; \
            url="${base}/${MINIO_RELEASE}/minio.linux-amd64.${MINIO_RELEASE}"; \
            echo "downloading ${url}"; \
            if curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 --retry-all-errors \
                -o "$binary.part" "$url"; then \
                if [ -s "$binary.part" ]; then \
                    mv "$binary.part" "$binary"; \
                    ok=1; \
                    break; \
                fi; \
            fi; \
            rm -f "$binary.part"; \
        done; \
        [ "$ok" = 1 ] || { \
            echo "minio binary download failed from all sources." >&2; \
            echo "Options: docker compose pull minio; docker load a saved image; or build with" >&2; \
            echo "  --build-arg MINIO_BINARY_MIRROR=<working mirror> / --build-arg HTTPS_PROXY=<proxy>" >&2; \
            exit 1; \
        }; \
    fi; \
    cp "$binary" /usr/bin/minio; \
    chmod 0755 /usr/bin/minio

EXPOSE 9000 9001
# Root by default, matching the previous official image so the named /data
# volume gets usable ownership on first mount.
ENTRYPOINT ["/usr/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]
