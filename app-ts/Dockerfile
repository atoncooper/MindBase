# app-ts: Node 22 / Fastify agent service (tsx 直跑，无编译产物)。
# 纯 npm 依赖，无系统包：Office -> PDF 走 Gotenberg 侧车，PDF -> PNG 用 @hyzyla/pdfium (WASM)。
# LibreOffice/poppler 只出现在 CI/评测镜像 docker/office-eval.Dockerfile。
FROM node:22-bookworm-slim

WORKDIR /app

# 依赖层（package*.json 变化才重建）
COPY app-ts/package.json app-ts/package-lock.json* ./
# 默认 npmmirror；需要官方源时 --build-arg NPM_REGISTRY=https://registry.npmjs.org
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm install --registry=$NPM_REGISTRY

ENV NODE_ENV=production
ENV LANG=C.UTF-8

# 源码 + gRPC proto（运行时加载）
COPY app-ts/ ./
COPY proto/ ./proto/

# 日志目录必须存在且可写，否则 pino 启动失败
RUN mkdir -p /app/logs && chown -R node:node /app/logs
EXPOSE 8000
USER node

CMD ["npx", "tsx", "src/index.ts"]
