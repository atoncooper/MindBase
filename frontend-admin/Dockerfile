# Build the Vite SPA with the pnpm major version used by this lockfile.
FROM node:22-alpine AS build

WORKDIR /src
RUN corepack enable && corepack prepare pnpm@9.15.5 --activate

COPY frontend-admin/package.json frontend-admin/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY frontend-admin/index.html frontend-admin/tsconfig.json frontend-admin/vite.config.ts ./
COPY frontend-admin/src ./src
RUN pnpm build

# Serve only the static bundle. Nginx proxies /api to app-admin over the
# compose network, keeping the browser on one same-origin, loopback-only URL.
FROM nginx:stable-alpine

COPY nginx/app-admin.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
