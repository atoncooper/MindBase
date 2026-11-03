#!/usr/bin/env bash
# Install/upgrade OpenSandbox (Kubernetes runtime) for MindBase.
#
#   export OPENSANDBOX_API_KEY=$(openssl rand -hex 32)
#   bash deploy/k8s/40-sandbox/install.sh                 # prod profile
#   bash deploy/k8s/40-sandbox/install.sh --profile dev   # small cluster
#   bash deploy/k8s/40-sandbox/install.sh --skip-pool --with-policy --smoke
#
# Profiles: values/opensandbox.yaml + values/opensandbox-${PROFILE}.yaml
# Pinned upstream release: OPENSANDBOX_RELEASE=release-X.Y.Z
# Requires: kubectl, helm 3, git.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE="${OPENSANDBOX_RELEASE:-release-1.2.0}"
REPO="${OPENSANDBOX_REPO:-https://github.com/opensandbox-group/OpenSandbox.git}"
CACHE="${OPENSANDBOX_CACHE:-${TMPDIR:-/tmp}/opensandbox-${RELEASE}}"
NAMESPACE="${OPENSANDBOX_NAMESPACE:-opensandbox-system}"
WORKLOAD_NAMESPACE="${OPENSANDBOX_WORKLOAD_NAMESPACE:-opensandbox}"
PROFILE="${OPENSANDBOX_PROFILE:-prod}"
SKIP_POOL=0
WITH_POLICY=0
RUN_SMOKE=0
DRY_RUN=0
HELM_EXTRA_ARGS="${HELM_EXTRA_ARGS:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --profile=*) PROFILE="${1#*=}"; shift ;;
    --skip-pool) SKIP_POOL=1; shift ;;
    --with-policy) WITH_POLICY=1; shift ;;
    --smoke) RUN_SMOKE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

VALUES_COMMON="${HERE}/values/opensandbox.yaml"
VALUES_OVERLAY="${HERE}/values/opensandbox-${PROFILE}.yaml"
[[ -f "${VALUES_COMMON}" && -f "${VALUES_OVERLAY}" ]] || { echo "values not found for profile ${PROFILE}" >&2; exit 2; }
: "${OPENSANDBOX_API_KEY:?set OPENSANDBOX_API_KEY (same value used by app-sandbox)}"

for tool in kubectl helm git; do command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }; done
kubectl cluster-info >/dev/null || { echo "kubectl cannot reach the cluster" >&2; exit 1; }

echo "==> [1/7] namespaces"
kubectl apply -f "${HERE}/manifests/00-namespace.yaml"

echo "==> [2/7] API key secrets (${NAMESPACE} + mind-base)"
kubectl get namespace mind-base >/dev/null 2>&1 || kubectl create namespace mind-base
for ns in "${NAMESPACE}" mind-base; do
  kubectl -n "$ns" create secret generic opensandbox-api-key \
    --from-literal=api-key="${OPENSANDBOX_API_KEY}" \
    --dry-run=client -o yaml | kubectl apply -f -
done

echo "==> [3/7] checkout ${RELEASE} and build chart dependencies"
if [ ! -d "${CACHE}/.git" ]; then
  git clone --depth 1 --branch "${RELEASE}" "${REPO}" "${CACHE}"
else
  git -C "${CACHE}" fetch --tags --depth 1 origin "${RELEASE}"
  git -C "${CACHE}" checkout --force "${RELEASE}"
fi
cd "${CACHE}/manifests/charts"
helm dependency build opensandbox

echo "==> [4/7] helm upgrade --install opensandbox (profile=${PROFILE})"
HELM_ARGS=(
  upgrade --install opensandbox ./opensandbox
  --namespace "${NAMESPACE}" --create-namespace
  --values "${VALUES_COMMON}" --values "${VALUES_OVERLAY}"
  --atomic --cleanup-on-fail --wait --timeout 15m
)
if [[ "${DRY_RUN}" == "1" ]]; then
  helm "${HELM_ARGS[@]}" --dry-run ${HELM_EXTRA_ARGS}
  exit 0
fi
# shellcheck disable=SC2086
helm "${HELM_ARGS[@]}" ${HELM_EXTRA_ARGS}

echo "==> [5/7] CRD / control-plane checks"
kubectl wait --for=condition=Available deployment/opensandbox-server -n "${NAMESPACE}" --timeout=300s
kubectl wait --for=condition=Available deployment/opensandbox-controller-manager -n "${NAMESPACE}" --timeout=300s
kubectl get crd pools.sandbox.opensandbox.io batchsandboxes.sandbox.opensandbox.io >/dev/null

echo "==> [6/7] PDB + warm pool"
if [[ "${PROFILE}" == "prod" ]]; then
  kubectl apply -f "${HERE}/manifests/pdb.yaml"
else
  echo "  skip PDB in dev profile (single-replica gateway cannot satisfy minAvailable)"
fi
if [[ "${SKIP_POOL}" != "1" ]]; then
  kubectl apply -f "${HERE}/manifests/pool-python.yaml"
fi
if [[ "${WITH_POLICY}" == "1" ]]; then
  kubectl apply -f "${HERE}/manifests/networkpolicy.yaml"
fi

echo "==> [7/7] status"
kubectl -n "${NAMESPACE}" get deploy,pods
kubectl -n "${WORKLOAD_NAMESPACE}" get pool,pods 2>/dev/null || true

if [[ "${RUN_SMOKE}" == "1" ]]; then
  echo "==> smoke test (create execution through app-sandbox)"
  kubectl -n mind-base get deployment/app-sandbox >/dev/null || {
    echo "app-sandbox is not deployed yet; run 'kubectl apply -k deploy/k8s' first" >&2
    exit 1
  }
  kubectl -n mind-base delete job sandbox-smoke --ignore-not-found
  kubectl apply -f "${HERE}/manifests/smoke-test-job.yaml"
  kubectl -n mind-base wait --for=condition=Complete job/sandbox-smoke --timeout=180s
  kubectl -n mind-base logs job/sandbox-smoke
fi

echo
echo "OpenSandbox ready. Next:"
echo "  kubectl apply -k deploy/k8s   # app-sandbox (runtime=opensandbox) + app-admin"
echo "  deploy/k8s/40-sandbox/README.md sections 5/7 verify and upgrade"
