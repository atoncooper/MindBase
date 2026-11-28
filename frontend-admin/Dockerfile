# Build the Vite SPA with the pnpm major version used by this lockfile.
FROM node:22-alpine AS build

WORKDIR /src
# corepack fetches the pnpm release from the npm registry; default to the China
# mirror (same rationale as frontendv2/Dockerfile's NPM_REGISTRY) so the build
# does not stall/fail on registry.npmjs.org. Override with
# --build-arg NPM_REGISTRY=https://registry.npmjs.org when needed.
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY
RUN npm config set registry "$NPM_REGISTRY" \
    && corepack enable && corepack prepare pnpm@9.15.5 --activate

COPY frontend-admin/package.json frontend-admin/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --registry="$NPM_REGISTRY"

COPY frontend-admin/index.html frontend-admin/tsconfig.json frontend-admin/vite.config.ts ./
COPY frontend-admin/src ./src
RUN pnpm build

# Serve only the static bundle. Nginx proxies /api to app-admin over the
# compose network, keeping the browser on one same-origin, loopback-only URL.
FROM nginx:stable-alpine

COPY frontend-admin/app-admin.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
