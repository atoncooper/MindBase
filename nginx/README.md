# Nginx configuration layout

- `nginx.conf` is the **main gateway configuration**. It owns the `events` / `http` context, shared maps, caches, rate limits, and the HTTP/HTTPS server blocks.
- `locations.conf` is **not a second standalone Nginx config**. It is a fragment containing the shared `location` routes, included by both gateway server blocks in `nginx.conf`.
- `app-admin.conf` is the complete server config for the **separate app-admin UI Nginx container**. `frontend-admin/Dockerfile` copies it to `/etc/nginx/conf.d/default.conf`; it serves the SPA and proxies same-origin `/api` requests to `app-admin-api`.

For routes on the main gateway, add or update locations in `locations.conf`. Keep the admin static server in `app-admin.conf`; do not duplicate it in the main gateway config unless the deployment is deliberately changed to serve the admin UI through that gateway.

Keeping the gateway's route fragment separate avoids copying the full route table into both HTTP and HTTPS server blocks. Flattening it into `nginx.conf` would duplicate hundreds of lines and let the HTTP/HTTPS route policies drift apart; the include is the shared single source for those routes.
