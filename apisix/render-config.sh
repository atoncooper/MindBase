#!/bin/sh
# Render the APISIX standalone route/consumer config from its template.
#
# APISIX's yaml provider cannot read environment variables, so secrets must be
# substituted before apisix starts. This script is invoked by the container
# entrypoint (compose/swarm) or by a k8s initContainer. The rendered file is
# written inside the container only; the committed template holds placeholders.
#
# Required env:
#   APISIX_CONSUMER_KEY   shared internal consumer key (also used for
#                         X-Internal-Key / X-API-Key injection)
# Optional env (random per render when unset):
#   PAY_READONLY_KEY      pay_readonly consumer (membership reads)
#   PAY_OPS_KEY           pay_ops consumer (grant / refund); app-admin uses it
#
# Usage: render-config.sh <template> <output>
set -eu

tpl=${1:-}
out=${2:-}
if [ -z "$tpl" ] || [ -z "$out" ]; then
  echo "usage: render-config.sh <template> <output>" >&2
  exit 2
fi
if [ ! -f "$tpl" ]; then
  echo "[apisix-config] template not found: $tpl" >&2
  exit 1
fi
if [ -z "${APISIX_CONSUMER_KEY:-}" ]; then
  echo "[apisix-config] APISIX_CONSUMER_KEY is required" >&2
  exit 1
fi

random_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 36 | tr -d '\n=+/' | cut -c1-48
  elif command -v base64 >/dev/null 2>&1; then
    head -c 36 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-48
  else
    od -An -N36 -tx1 /dev/urandom | tr -d ' \n' | cut -c1-48
  fi
}

escape_sed() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/&/\\&/g' -e 's/|/\\|/g'
}

pay_readonly=${PAY_READONLY_KEY:-$(random_key)}
pay_ops=${PAY_OPS_KEY:-$(random_key)}
# app-pay 服务端二次校验 key（X-Internal-Key）：未单独配置时回落到共享内部 key，
# 与 app-pay 的 ${PAY_INTERNAL_KEY:${APISIX_CONSUMER_KEY:}} 默认值保持一致。
pay_internal=${PAY_INTERNAL_KEY:-${APISIX_CONSUMER_KEY:-}}

sed \
  -e "s|__APISIX_CONSUMER_KEY__|$(escape_sed "$APISIX_CONSUMER_KEY")|g" \
  -e "s|__PAY_INTERNAL_KEY__|$(escape_sed "$pay_internal")|g" \
  -e "s|__PAY_READONLY_KEY__|$(escape_sed "$pay_readonly")|g" \
  -e "s|__PAY_OPS_KEY__|$(escape_sed "$pay_ops")|g" \
  "$tpl" > "$out"

# ---- Internal TLS termination certificate (9443 listener) ----
# The APISIX yaml provider needs the SSL resource declared with PEM bodies
# (apisix.ssl.cert/key alone is only the SNI-less fallback). Render the leaf
# issued by cert-gen into the declarative ssls block; drop the block when no
# certificate is mounted so APISIX still boots HTTP-only.
tls_cert_file=${APISIX_TLS_CERT_FILE:-/usr/local/apisix/conf/certs/apisix/server.crt}
tls_key_file=${APISIX_TLS_KEY_FILE:-/usr/local/apisix/conf/certs/apisix/server.key}
if grep -q '__APISIX_TLS_CERT_PEM__' "$out"; then
  if [ -s "$tls_cert_file" ] && [ -s "$tls_key_file" ]; then
    awk -v certfile="$tls_cert_file" -v keyfile="$tls_key_file" '
      /__APISIX_TLS_CERT_PEM__/ {
        while ((getline line < certfile) > 0) print "      " line
        close(certfile); next
      }
      /__APISIX_TLS_KEY_PEM__/ {
        while ((getline line < keyfile) > 0) print "      " line
        close(keyfile); next
      }
      { print }
    ' "$out" > "$out.tls.tmp" && mv "$out.tls.tmp" "$out"
  else
    awk '/^# BEGIN-INTERNAL-TLS$/ {skip=1; next} /^# END-INTERNAL-TLS$/ {skip=0; next} !skip {print}'       "$out" > "$out.tls.tmp" && mv "$out.tls.tmp" "$out"
    echo "[apisix-config] WARNING: internal TLS cert missing ($tls_cert_file); 9443 SNI cert disabled" >&2
  fi
fi

if grep -q '__APISIX_CONSUMER_KEY__\|__PAY_READONLY_KEY__\|__PAY_OPS_KEY__\|__PAY_INTERNAL_KEY__\|__APISIX_TLS_' "$out"; then
  echo "[apisix-config] placeholder left after render; check template" >&2
  exit 1
fi
chmod 640 "$out" 2>/dev/null || true
echo "[apisix-config] rendered $out from $tpl"
