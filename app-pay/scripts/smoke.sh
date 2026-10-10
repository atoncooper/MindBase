#!/usr/bin/env bash
# app-pay local smoke test: full flow of create order (MOCK) -> simulate payment -> activate membership.
# Prerequisites: app-pay is running (HTTPS-only; run app-pay/scripts/gen-dev-cert.sh|.ps1 first for local certs),
#       test endpoints are enabled (on by default for the local /test profile) and PAY_TEST_TOKEN matches the server.
# Usage: PAY_TEST_TOKEN=xxx ./app-pay/scripts/smoke.sh [base_url, default https://127.0.0.1:8002]
set -euo pipefail

BASE="${1:-https://127.0.0.1:8002}"
: "${PAY_TEST_TOKEN:-}"
H=(-H "X-Test-Token: ${PAY_TEST_TOKEN}" -H "Content-Type: application/json")
UID=10086

# TLS: prefer trusting the local development CA; fall back to -k when ca.crt is absent (still encrypted, only skips identity verification)
CERT_DIR="$(cd "$(dirname "$0")/../certs" 2>/dev/null && pwd || true)"
if [ -n "${CERT_DIR:-}" ] && [ -f "$CERT_DIR/ca.crt" ]; then
  TLS=(--cacert "$CERT_DIR/ca.crt")
else
  TLS=(-k)
fi

echo "== 1) Product list =="
curl -sS "${TLS[@]}" "${H[@]}" "${BASE}/test/pay/products"; echo

echo "== 2) Create order (MOCK, uid=${UID}, VIP_MONTHLY) =="
ORDER=$(curl -sS "${TLS[@]}" "${H[@]}" -d "{\"uid\":${UID},\"skuCode\":\"VIP_MONTHLY\",\"channel\":\"MOCK\"}" "${BASE}/test/pay/orders")
echo "${ORDER}"
ORDER_NO=$(echo "${ORDER}" | sed -n 's/.*"orderNo":"\([^"]*\)".*/\1/p')
[ -n "${ORDER_NO}" ] || { echo "!! orderNo not retrieved, aborting"; exit 1; }

echo "== 3) Simulate successful payment (orderNo=${ORDER_NO}) =="
curl -sS "${TLS[@]}" "${H[@]}" -d "{\"uid\":${UID},\"orderNo\":\"${ORDER_NO}\"}" "${BASE}/test/pay/mock-pay"; echo

echo "== 4) Membership status (expect active=true, expireAt≈+30d) =="
curl -sS "${TLS[@]}" "${H[@]}" "${BASE}/test/pay/membership/${UID}"; echo

echo "== Done. See the app-pay container logs/pay-audit.jsonl for the audit stream =="
