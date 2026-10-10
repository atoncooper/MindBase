# ====== app-bili: bilibili data acquisition service (Go) ======
# Multi-stage build: compile static binary, ship on distroless + static ffmpeg.
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

# Static build (CGO disabled for distroless)
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/app-bili .

# ffmpeg/ffprobe: static builds (ASR 前的音频转码/切块依赖；distroless 无法装包)
FROM mwader/static-ffmpeg:7.1 AS ffmpeg

# ---- runtime image ----
FROM gcr.io/distroless/static-debian12:nonroot

LABEL app="mind-base-app-bili"

WORKDIR /app
COPY --from=builder /out/app-bili /app/app-bili
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe

EXPOSE 8010
USER nonroot:nonroot

ENTRYPOINT ["/app/app-bili"]
