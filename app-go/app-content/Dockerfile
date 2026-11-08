# ====== app-content: board + note + quiz content store (Go) ======
# Single module / image / process; all three domains mounted on ONE port (8004, TLS).
FROM golang:1.25-alpine AS builder

WORKDIR /src

# Use China mirror for Go modules (goproxy.cn) with direct fallback.
ENV GOPROXY=https://goproxy.cn,direct
ENV GOSUMDB=off

COPY go.mod go.sum* ./
RUN go mod download || true

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/app-content ./cmd/app-content

# Placeholder so the logs directory can be COPY-ed into the distroless stage
# with nonroot ownership (the image has no shell to mkdir/chown at runtime).
RUN mkdir -p /out/logs && touch /out/logs/.keep

# ---- runtime image ----
FROM gcr.io/distroless/static-debian12:nonroot

LABEL app="mind-base-app-content"

COPY --from=builder /out/app-content /app-content

# /app/logs is owned by nonroot so lumberjack can write when compose mounts the
# app_content_logs volume here (a named volume inherits the image dir's owner).
COPY --from=builder --chown=nonroot:nonroot /out/logs /app/logs

# TLS certs (board auto mode generates dev-CA + leaf here; compose mounts a volume)
VOLUME /app/certs

EXPOSE 8004
USER nonroot:nonroot

ENTRYPOINT ["/app-content"]
