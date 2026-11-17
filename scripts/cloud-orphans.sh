#!/usr/bin/env bash
# ============================================================
# Cloud orphan report / cleanup (administrator tool)
# ============================================================
# Orphan object = completed cloud-upload object with NO cloud_files row
# (client complete + MinIO webhook both missed, or a DB write failed).
# The daily sweep only REPORTS; deletion here is explicit and audited.
#
# Usage:
#   scripts/cloud-orphans.sh list [older_hours] [limit]     # report only
#   scripts/cloud-orphans.sh delete <older_hours> <key>...  # dry-run preview
#   scripts/cloud-orphans.sh delete --confirm <key>...      # actually delete
#
# Env:
#   MINIO_EVENT_TOKEN       admin bearer token (default dev-minio-event-token)
#   APP_CLOUD_INTERNAL_URL  app-cloud internal base (default https://127.0.0.1:8007)
#   APP_CLOUD_CA            CA bundle for app-cloud TLS (default secrets/certs/app-cloud/dev-ca.crt)
# ============================================================
set -euo pipefail

TOKEN="${MINIO_EVENT_TOKEN:-dev-minio-event-token}"
BASE="${APP_CLOUD_INTERNAL_URL:-https://127.0.0.1:8007}"
CA="${APP_CLOUD_CA:-secrets/certs/app-cloud/dev-ca.crt}"

cmd="${1:-list}"
shift || true
case "$cmd" in
  list)
    hours="${1:-48}"; limit="${2:-200}"
    curl -sS --cacert "$CA" -H "Authorization: Bearer $TOKEN" \
      "$BASE/internal/cloud/orphans?older_hours=$hours&limit=$limit"
    ;;
  delete)
    dry=true
    if [ "${1:-}" = "--confirm" ]; then dry=false; shift; fi
    if [ "$#" -lt 1 ]; then
      echo "usage: $0 delete [--confirm] <key> [key...]" >&2; exit 2
    fi
    keys=$(printf '%s\n' "$@" | python3 -c 'import json,sys; print(json.dumps({"keys":[l.strip() for l in sys.stdin if l.strip()],"dry_run":'"$dry"'}))')
    curl -sS --cacert "$CA" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -X POST -d "$keys" "$BASE/internal/cloud/orphans/delete"
    ;;
  *)
    echo "usage: $0 [list|delete] ..." >&2; exit 2
    ;;
esac
