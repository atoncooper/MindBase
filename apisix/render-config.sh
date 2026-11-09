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
#   PAY_READONLY_KEY      pay-readonly consumer (membership reads)
#   PAY_OPS_KEY           pay-ops consumer (grant / refund); app-admin uses it
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

sed \
  -e "s|__APISIX_CONSUMER_KEY__|$(escape_sed "$APISIX_CONSUMER_KEY")|g" \
  -e "s|__PAY_READONLY_KEY__|$(escape_sed "$pay_readonly")|g" \
  -e "s|__PAY_OPS_KEY__|$(escape_sed "$pay_ops")|g" \
  "$tpl" > "$out"

if grep -q '__APISIX_CONSUMER_KEY__\|__PAY_READONLY_KEY__\|__PAY_OPS_KEY__' "$out"; then
  echo "[apisix-config] placeholder left after render; check template" >&2
  exit 1
fi
chmod 640 "$out" 2>/dev/null || true
echo "[apisix-config] rendered $out from $tpl"
