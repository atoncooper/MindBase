# ====== app-ts: agent + RAG service (Node/Fastify) ======
# Build context = REPO ROOT (compose/CI pass context "." with this Dockerfile)
# so the shared proto/kg/v1/kg.proto can be copied in (runtime-loaded gRPC
# contract). Runs via tsx (no compile step); the "build" script is a type check.
FROM node:22-alpine

WORKDIR /app

# Deps first (cache)
COPY app-ts/package.json app-ts/package-lock.json* ./
# npm 默认源在本机网络不可达（连接被重置）；与宿主 ~/.npmrc 及 lockfile 对齐走 npmmirror
RUN npm install --registry=https://registry.npmmirror.com

# Source + runtime assets
COPY app-ts/ ./
COPY proto/ ./proto/

ENV NODE_ENV=production
# /app/logs must pre-exist owned by the runtime user — the file log target
# (default.yaml log.file) is /app/logs/app-ts.log and pino/sonic-boom aborts
# the process on EACCES otherwise (same pattern as the MCP server images).
RUN mkdir -p /app/logs && chown -R node:node /app/logs
# 8000 = the port the retired Python backend owned; app-ts inherits it
EXPOSE 8000
USER node

CMD ["npx", "tsx", "src/index.ts"]
