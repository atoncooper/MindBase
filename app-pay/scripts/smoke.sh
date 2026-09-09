#!/usr/bin/env bash
# app-pay 本机冒烟测试：下单(MOCK) → 模拟支付 → 会员开通 全流程。
# 前置：app-pay 已启动（HTTPS-only，本地证书先跑 app-pay/scripts/gen-dev-cert.sh|.ps1），
#       测试入口开启（本地/test profile 默认开）且 PAY_TEST_TOKEN 与服务端一致。
# 用法：PAY_TEST_TOKEN=xxx ./app-pay/scripts/smoke.sh [base_url，默认 https://127.0.0.1:8002]
set -euo pipefail

BASE="${1:-https://127.0.0.1:8002}"
: "${PAY_TEST_TOKEN:-}"
H=(-H "X-Test-Token: ${PAY_TEST_TOKEN}" -H "Content-Type: application/json")
UID=10086

# TLS：优先信任本地开发 CA，ca.crt 不存在时退回 -k（仍加密，仅跳过身份校验）
CERT_DIR="$(cd "$(dirname "$0")/../certs" 2>/dev/null && pwd || true)"
if [ -n "${CERT_DIR:-}" ] && [ -f "$CERT_DIR/ca.crt" ]; then
  TLS=(--cacert "$CERT_DIR/ca.crt")
else
  TLS=(-k)
fi

echo "== 1) 商品列表 =="
curl -sS "${TLS[@]}" "${H[@]}" "${BASE}/test/pay/products"; echo

echo "== 2) 创建订单（MOCK, uid=${UID}, VIP_MONTHLY）=="
ORDER=$(curl -sS "${TLS[@]}" "${H[@]}" -d "{\"uid\":${UID},\"skuCode\":\"VIP_MONTHLY\",\"channel\":\"MOCK\"}" "${BASE}/test/pay/orders")
echo "${ORDER}"
ORDER_NO=$(echo "${ORDER}" | sed -n 's/.*"orderNo":"\([^"]*\)".*/\1/p')
[ -n "${ORDER_NO}" ] || { echo "!! 未取到 orderNo，终止"; exit 1; }

echo "== 3) 模拟支付成功（orderNo=${ORDER_NO}）=="
curl -sS "${TLS[@]}" "${H[@]}" -d "{\"uid\":${UID},\"orderNo\":\"${ORDER_NO}\"}" "${BASE}/test/pay/mock-pay"; echo

echo "== 4) 会员状态（期待 active=true, expireAt≈+30d）=="
curl -sS "${TLS[@]}" "${H[@]}" "${BASE}/test/pay/membership/${UID}"; echo

echo "== 完成。审计流水见 app-pay 容器 logs/pay-audit.jsonl =="
