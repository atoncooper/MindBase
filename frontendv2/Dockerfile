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
# next build 会把 rewrites() 的 destination 固化进 routes-manifest.json（运行时
# env 不再参与求值），所以 MinIO 同源代理目标必须作为 build arg 注入。
# compose 传 http://nginx:80；宿主机本地构建缺省走 http://localhost。
ARG MINIO_PROXY_DEST=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_APISIX_HOST=$NEXT_PUBLIC_APISIX_HOST \
    MINIO_PROXY_DEST=$MINIO_PROXY_DEST

# Install dependencies first to leverage Docker's layer cache.
# registry 切国内镜像：package-lock 在 Windows 生成，Linux/musl 平台的
# @next/swc 二进制不在锁文件里，`next build` 会现场从 registry 下载约 60MB，
# 直连 npmjs 极易被掐断导致构建崩溃（download-swc 会读取 npm registry 配置，
# 所以这里一处设置同时管住 npm ci 和 swc 下载）。
RUN npm config set registry https://registry.npmmirror.com
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

# busybox wget 会把 localhost 解析成 IPv6 ::1，而 Next 只绑 IPv4 —— 用 127.0.0.1
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/ || exit 1

CMD ["node", "server.js"]
