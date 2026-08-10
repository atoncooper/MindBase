# ====== frontendv2: Next.js 16 (App Router, standalone output) ======
# Multi-stage build: builder compiles the standalone bundle, runner ships only
# the runtime artifacts. Mirrors frontend/Dockerfile with build-time env wiring
# for next.config.ts rewrites().

# ----- Stage 1: build -----
FROM node:22-alpine AS builder

WORKDIR /app

# NEXT_PUBLIC_* vars are inlined at build time, so they must be present during
# `next build` for next.config.ts rewrites() to evaluate correctly:
#   - NEXT_PUBLIC_API_URL: when non-empty, rewrites() returns [] and the app
#     relies on nginx to proxy API calls (production). Empty -> dev-style
#     rewrites that proxy to NEXT_PUBLIC_APISIX_HOST.
#   - NEXT_PUBLIC_APISIX_HOST: upstream APISIX host:port for dev rewrites.
# Override via: docker build --build-arg NEXT_PUBLIC_API_URL=...
ARG NEXT_PUBLIC_API_URL=""
ARG NEXT_PUBLIC_APISIX_HOST=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_APISIX_HOST=$NEXT_PUBLIC_APISIX_HOST

# Install dependencies first to leverage Docker's layer cache.
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build (output: "standalone", see next.config.ts).
COPY . .
RUN npm run build

# ----- Stage 2: run -----
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Run as a non-root user.
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001 -G appgroup

# Standalone server (server.js + traced node_modules) + static assets + public.
# standalone does NOT include .next/static or public/, so copy them separately.
COPY --from=builder --chown=appuser:appgroup /app/.next/standalone ./
COPY --from=builder --chown=appuser:appgroup /app/.next/static ./.next/static
COPY --from=builder --chown=appuser:appgroup /app/public ./public

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
