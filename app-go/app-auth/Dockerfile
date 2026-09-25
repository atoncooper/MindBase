# ====== app-auth: identity & access service (Go) ======
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

# Static build (CGO disabled for distroless)
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/app-auth .

# ---- runtime image ----
FROM gcr.io/distroless/static-debian12:nonroot

LABEL app="mind-base-app-auth"

COPY --from=builder /out/app-auth /app-auth

EXPOSE 8006
USER nonroot:nonroot

ENTRYPOINT ["/app-auth"]
