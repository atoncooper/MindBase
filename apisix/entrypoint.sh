#!/bin/sh
# MindBase APISIX entrypoint.
#
# 1. render the declarative seed from the template + env (render-config.sh);
# 2. build the CA trust bundle (system CAs + board CA + etcd mTLS CA);
# 3. start apisix-sync in the background (import seed into empty etcd, then
#    keep ssls/consumers in sync with rotated certs / .env keys);
# 4. hand over to the stock APISIX entrypoint, which runs apisix init +
#    init_etcd for traditional mode and starts OpenResty in the foreground.
set -eu

: "${APISIX_CONSUMER_KEY:?APISIX_CONSUMER_KEY is required (internal M2M API key)}"
: "${APISIX_ADMIN_KEY:?APISIX_ADMIN_KEY is required (Admin API / Dashboard UI key)}"
export APISIX_CONSUMER_KEY APISIX_ADMIN_KEY

# Fixed container paths: every stack mounts config.yaml / apisix.yaml.template /
# render-config.sh at these locations (k8s uses subPath mounts).
SEED_TEMPLATE=/usr/local/apisix/conf/apisix.yaml.template
RENDER_SCRIPT=/usr/local/apisix/conf/render-config.sh
SEED=/tmp/apisix-rendered/apisix.yaml
CA_BUNDLE=/tmp/ca-bundle.crt
mkdir -p "$(dirname "$SEED")"

sh "$RENDER_SCRIPT" "$SEED_TEMPLATE" "$SEED"

# The host may inject HTTP_PROXY into every container; APISIX's cosocket/etcd
# clients must not use it for internal service names.
unset HTTP_PROXY http_proxy HTTPS_PROXY https_proxy

cat /etc/ssl/certs/ca-certificates.crt > "$CA_BUNDLE"
# board CA (upstream trust) + etcd CA (etcd mTLS) + apisix CA (Admin TLS cert
# verification for apisix-sync). Later stacks may mount a subset.
for f in /usr/local/apisix/conf/certs/board/dev-ca.crt \
         /usr/local/apisix/conf/certs/etcd/dev-ca.crt \
         /usr/local/apisix/conf/certs/apisix/dev-ca.crt; do
  if [ -s "$f" ]; then cat "$f" >> "$CA_BUNDLE"; fi
done

/usr/local/bin/apisix-sync \
  --seed "$SEED" \
  --admin-url https://127.0.0.1:9180 \
  --ca "$CA_BUNDLE" \
  --server-name localhost \
  --wait 180s \
  --interval 60s &

exec /docker-entrypoint.sh docker-start
