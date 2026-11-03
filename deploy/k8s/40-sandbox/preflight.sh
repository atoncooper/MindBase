#!/usr/bin/env bash
# Read-only preflight checks before installing OpenSandbox.
#   bash deploy/k8s/40-sandbox/preflight.sh
set -euo pipefail
fail=0
check() { if "$@" >/dev/null 2>&1; then echo "  ok: $*"; else echo "  FAIL: $*"; fail=1; fi; }
warn() { echo "  warn: $*"; }

echo "== tools =="
check command -v kubectl
check command -v helm
check command -v git
[[ -n "${OPENSANDBOX_API_KEY:-}" ]] && echo "  ok: OPENSANDBOX_API_KEY set" || { echo "  FAIL: OPENSANDBOX_API_KEY not set"; fail=1; }

echo "== cluster =="
check kubectl cluster-info
check kubectl get nodes
echo "  context: $(kubectl config current-context 2>/dev/null || echo unknown)"
helm version --short 2>/dev/null | sed 's/^/  helm: /'

echo "== storage / capacity =="
kubectl get storageclass 2>/dev/null | sed 's/^/  /' || warn "no storageclass (sandbox Pods use emptyDir; database PVCs need one)"
kubectl get nodes -o custom-columns=NAME:.metadata.name,CPU:.status.allocatable.cpu,MEM:.status.allocatable.memory 2>/dev/null | sed 's/^/  /'
echo "  sizing hint (prod): server 1x(1cpu/2Gi), gateway 3x(0.5cpu/0.5Gi), controller 2x(0.2cpu/0.25Gi), pool pod 0.25cpu/0.25Gi each"

echo "== existing release =="
if helm status opensandbox -n opensandbox-system >/dev/null 2>&1; then
  echo "  existing release found (helm upgrade path; CRDs stay)"
  helm list -n opensandbox-system | sed 's/^/  /'
else
  echo "  no existing opensandbox release"
fi

echo "== image hints =="
echo "  opensandbox registry: sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/*"
echo "  app image: atoncooper/mind-base-app-sandbox:latest (build from app-go/app-sandbox)"

exit "${fail}"
