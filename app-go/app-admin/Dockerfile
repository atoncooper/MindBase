# ====== app-admin: unified admin console (Go; share moderation + payment ops) ======
# Multi-stage build: compile static binary, ship on distroless.
# FROM 按 digest 固定：BuildKit 每次都会联网解析 tag（GFW 下 auth.docker.io 超时
# 直接失败），digest 引用命中本地镜像即可离线构建（同其它 Go 服务的既有做法）。
# 升级基础镜像时：docker pull 后用 docker images --digests 取新 digest 替换。
FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS builder

WORKDIR /src

# Module proxy is a build argument so restricted networks can override it:
#   docker compose build --build-arg GOPROXY=https://mirrors.aliyun.com/goproxy/,direct app-admin-api
# GOSUMDB off: sum.golang.org is often unreachable behind GFW.
ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=${GOPROXY}
ENV GOSUMDB=off

# Copy source first: go build fetches only the modules imported by the
# production binary (test-only dependencies are not downloaded), which keeps
# the network footprint small on restricted connections. BuildKit cache mounts
# keep modules / compiled objects across retries when a fetch times out.
COPY . .

# Static build (CGO disabled for distroless)
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/app-admin . \
    && mkdir -p /out/empty-logs

# ---- runtime image ----
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab

LABEL app="mind-base-app-admin"

# WORKDIR /app: docker run needs no config overlay (default.yaml is embedded).
# The project-root .env is not shipped; compose injects APPADMIN__ env instead.
WORKDIR /app
COPY --from=builder /out/app-admin /app-admin
# Writable log dir for the nonroot user (distroless has no shell/mkdir; the
# dir is built in the builder stage and chowned).
COPY --from=builder --chown=65532:65532 /out/empty-logs /app/logs

EXPOSE 8016
USER nonroot:nonroot

ENTRYPOINT ["/app-admin"]