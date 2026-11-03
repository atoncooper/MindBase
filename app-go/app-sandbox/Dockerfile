# ====== app-sandbox: code-execution control plane (Go) ======
# Multi-stage build: compile a static binary, ship it on distroless.
# The service only talks HTTP/MySQL — no CGO, no shell in the image.
FROM golang:1.24-alpine AS builder

WORKDIR /src

# China mirror with direct fallback; sum.golang.org is often unreachable.
ENV GOPROXY=https://goproxy.cn,direct
ENV GOSUMDB=off

COPY go.mod go.sum* ./
RUN go mod download

COPY . .

RUN mkdir -p /out/logs && \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/app-sandbox .

# ---- runtime image ----
FROM gcr.io/distroless/static-debian12:nonroot

LABEL app="mind-base-app-sandbox"

COPY --from=builder /out/app-sandbox /app-sandbox
COPY --from=builder --chown=65532:65532 /out/logs /app/logs

EXPOSE 8017
USER nonroot:nonroot

ENTRYPOINT ["/app-sandbox"]
