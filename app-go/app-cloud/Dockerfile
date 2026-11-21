# ====== app-cloud: identity & access service (Go) ======
# Multi-stage build: compile static binary, ship on distroless.
FROM golang:1.25-alpine AS builder

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

# Static build (CGO disabled; runtime image is Alpine because HLS needs ffmpeg)
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/app-cloud .

# ---- runtime image ----
# Alpine (not distroless) because HLS packaging needs ffmpeg. The app binary is
# static; ffmpeg is invoked only by the async HLS worker, never on the playback
# byte path.
FROM alpine:3.21

RUN apk add --no-cache ca-certificates ffmpeg tzdata \
    && addgroup -S -g 10001 app \
    && adduser -S -D -H -u 10001 -G app app

LABEL app="mind-base-app-cloud"

COPY --from=builder /out/app-cloud /app-cloud

ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
EXPOSE 8007
USER 10001:10001

ENTRYPOINT ["/app-cloud"]