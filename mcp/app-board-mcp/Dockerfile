# ====== app-board-mcp: MCP server for the app-board store (Go) ======
# Multi-stage build: compile static binary, ship on distroless.
FROM golang:1.25-alpine AS builder

WORKDIR /src

# Use China mirror for Go modules (goproxy.cn) with direct fallback.
# GOSUMDB off: sum.golang.org is often unreachable behind GFW.
# If module downloads fail inside the build container (network resets), build
# with the host proxy:
#   docker compose build --build-arg HTTP_PROXY=http://host.docker.internal:10808 \
#                        --build-arg HTTPS_PROXY=http://host.docker.internal:10808 app-board-mcp
ENV GOPROXY=https://goproxy.cn,direct
ENV GOSUMDB=off

# Cache deps first
COPY go.mod go.sum ./
RUN go mod download

# Copy source
COPY . .

# Static build (CGO disabled for distroless)
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/app-board-mcp .

# Empty dir copied into the runtime image with nonroot ownership so the
# lumberjack file sink can actually write (a mounted volume inherits this
# ownership on first use — without it the root-owned volume dir blocks writes).
RUN mkdir -p /out/logs

# ---- runtime image ----
FROM gcr.io/distroless/static-debian12:nonroot

LABEL app="mind-base-app-board-mcp"

WORKDIR /app
COPY --from=builder /out/app-board-mcp /app/app-board-mcp
COPY --from=builder --chown=65532:65532 /out/logs /app/logs

EXPOSE 8005
USER nonroot:nonroot

# Container deployment pins the streamable-http transport (see compose).
ENTRYPOINT ["/app/app-board-mcp", "--transport", "http", "--http-addr", ":8005"]
