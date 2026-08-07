# ====== app-task: independent task executor (Go) ======
# Multi-stage build: compile static binary, ship on distroless.
FROM golang:1.22-alpine AS builder

WORKDIR /src

# Cache deps first
COPY go.mod go.sum* ./
RUN go mod download || true

# Copy source
COPY . .

# Static build (CGO disabled for distroless)
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/app-task .

# ---- runtime image ----
FROM gcr.io/distroless/static-debian12:nonroot

LABEL app="mind-base-app-task"

COPY --from=builder /out/app-task /app-task

EXPOSE 8001
USER nonroot:nonroot

ENTRYPOINT ["/app-task"]
