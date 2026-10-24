# ====== app-admin: share-moderation admin console (Go) ======
# Multi-stage build: compile static binary, ship on distroless.
# FROM 按 digest 固定：BuildKit 每次都会联网解析 tag（GFW 下 auth.docker.io 超时
# 直接失败），digest 引用命中本地镜像即可离线构建（同 app-pay-admin 的既有做法）。
# 升级基础镜像时：docker pull 后用 docker images --digests 取新 digest 替换。
FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS builder

WORKDIR /src

# Use China mirror for Go modules (goproxy.cn) with direct fallback.
# GOSUMDB off: sum.golang.org is often unreachable behind GFW.
ENV GOPROXY=https://goproxy.cn,direct
ENV GOSUMDB=off

# Cache deps first
COPY go.mod go.sum* ./
RUN go mod download || true

# Copy source
COPY . .

# Static build (CGO disabled for distroless)
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/app-admin . \
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