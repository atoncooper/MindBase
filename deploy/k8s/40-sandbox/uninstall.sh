#!/usr/bin/env bash
# Uninstall OpenSandbox. CRDs carry helm.sh/resource-policy: keep and are
# retained (Pool/BatchSandbox objects survive); namespaces are kept too.
#   bash deploy/k8s/40-sandbox/uninstall.sh            # safe
#   bash deploy/k8s/40-sandbox/uninstall.sh --purge    # delete CRDs + namespaces
set -euo pipefail
PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1
NS="${OPENSANDBOX_NAMESPACE:-opensandbox-system}"
helm uninstall opensandbox -n "${NS}" || true
if [[ "${PURGE}" == "1" ]]; then
  echo "WARNING: deleting CRDs and sandbox namespaces in 10s (Ctrl-C to abort)..."
  sleep 10
  kubectl delete crd batchsandboxes.sandbox.opensandbox.io \
    pools.sandbox.opensandbox.io sandboxsnapshots.sandbox.opensandbox.io --ignore-not-found
  kubectl delete namespace opensandbox "${NS}" --ignore-not-found
fi
echo "done. app-sandbox /ready stays false until OpenSandbox is reinstalled or disabled."
