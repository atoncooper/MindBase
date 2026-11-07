# ====== app-user: consolidated user domain (auth + settings + bili) ======
# One Go module / one image / one container; three HTTP listeners (8006/8010/8015).
FROM golang:1.25-alpine AS builder

WORKDIR /src

ENV GOPROXY=https://goproxy.cn,direct
ENV GOSUMDB=off

COPY go.mod go.sum* ./
RUN go mod download || true

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/app-user ./cmd/app-user

# ffmpeg/ffprobe: static builds (ASR audio transcode/chunking; distroless cannot install packages)
FROM mwader/static-ffmpeg:7.1 AS ffmpeg

# ---- runtime image ----
FROM gcr.io/distroless/static-debian12:nonroot

LABEL app="mind-base-app-user"

WORKDIR /app
COPY --from=builder /out/app-user /app/app-user
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe

EXPOSE 8006 8010 8015
USER nonroot:nonroot

ENTRYPOINT ["/app/app-user"]
