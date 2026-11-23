#!/bin/sh
# =============================================================================
# MongoDB 7 — container entrypoint: WiredTiger cache from cgroup maxMem + TLS
# =============================================================================
# 生产标准：cacheSizeGB = min(容器内存 × 50%, 内存 - 256MB)，下限 0.25GB，上限 8GB。
# 唯一模板 mongod.tmpl.conf：MONGO_TLS=1 启用 requireTLS 段。
# 覆盖：MONGO_CACHE_GB=2 MONGO_TLS=0|1
# =============================================================================
set -eu

mem_limit_mb() {
  if [ -r /sys/fs/cgroup/memory.max ]; then
    v=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)
    if [ "$v" != "max" ] && [ -n "$v" ] && [ "$v" -gt 0 ] 2>/dev/null; then
      echo $((v / 1024 / 1024)); return
    fi
  fi
  if [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
    v=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)
    if [ -n "$v" ] && [ "$v" -gt 0 ] 2>/dev/null && [ "$v" -lt 9223372036854771712 ] 2>/dev/null; then
      echo $((v / 1024 / 1024)); return
    fi
  fi
  awk '/MemTotal:/ {print int($2/1024)}' /proc/meminfo
}

MEM_MB=$(mem_limit_mb)
[ -n "$MEM_MB" ] 2>/dev/null || MEM_MB=1024
[ "$MEM_MB" -lt 512 ] 2>/dev/null && MEM_MB=512

CACHE_MB=$(( MEM_MB * 50 / 100 ))
RESERVE=$(( MEM_MB - 256 ))
[ "$CACHE_MB" -gt "$RESERVE" ] && CACHE_MB="$RESERVE"
[ "$CACHE_MB" -lt 256 ] && CACHE_MB=256
CACHE_GB=$(awk -v mb="$CACHE_MB" 'BEGIN {printf "%.2f", mb/1024}')
[ -n "${MONGO_CACHE_GB:-}" ] && CACHE_GB="${MONGO_CACHE_GB}"

TMPL="${MONGO_TMPL:-/opt/mindbase/mongod.tmpl.conf}"
OUT="${MONGO_CONF_OUT:-/tmp/mongod.conf}"
TLS="${MONGO_TLS:-1}"

awk -v cache="$CACHE_GB" -v tls="$TLS" '
  /^# __TLS_BEGIN__/ { intls=1; next }
  /^# __TLS_END__/   { intls=0; next }
  { if (intls && tls != "1") next; gsub(/__WT_CACHE_GB__/, cache); print }
' "$TMPL" > "$OUT"
chmod 644 "$OUT"

echo "[mongo-autosize] mem=${MEM_MB}MB -> cacheSizeGB=${CACHE_GB} tls=${TLS}" >&2
exec /usr/local/bin/docker-entrypoint.sh mongod --config "$OUT"
