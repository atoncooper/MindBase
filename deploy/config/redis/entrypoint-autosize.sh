#!/bin/sh
# =============================================================================
# Redis 7 — container entrypoint: maxmemory from cgroup maxMem
# =============================================================================
# 生产标准：maxmemory = 容器内存上限 × 70%（至少 64MB），策略 noeviction——
# Redis 里存的是登录会话/配额预占/事件，宁可写失败（OOM 报错）也不能静默驱逐。
# 静态配置在 REDIS_CONF（TLS 或明文），本脚本只补容量参数；口令仍来自 .env。
#
# 覆盖：REDIS_MAXMEMORY_MB=768 REDIS_MAXMEMORY_POLICY=allkeys-lru
# =============================================================================
set -eu

mem_limit_mb() {
  # cgroup v2
  if [ -r /sys/fs/cgroup/memory.max ]; then
    v=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)
    if [ "$v" != "max" ] && [ -n "$v" ] && [ "$v" -gt 0 ] 2>/dev/null; then
      echo $((v / 1024 / 1024)); return
    fi
  fi
  # cgroup v1
  if [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
    v=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)
    if [ -n "$v" ] && [ "$v" -gt 0 ] 2>/dev/null && [ "$v" -lt 9223372036854771712 ] 2>/dev/null; then
      echo $((v / 1024 / 1024)); return
    fi
  fi
  # no limit: use host MemTotal
  awk '/MemTotal:/ {print int($2/1024)}' /proc/meminfo
}
cpu_limit() {
  # cgroup v2: "<quota> <period>" or "max <period>"
  if [ -r /sys/fs/cgroup/cpu.max ]; then
    set -- $(cat /sys/fs/cgroup/cpu.max 2>/dev/null)
    q=$1; p=${2:-100000}
    if [ "$q" != "max" ] && [ -n "$q" ] && [ "$q" -gt 0 ] 2>/dev/null; then
      echo $(( (q + p - 1) / p )); return
    fi
  fi
  # cgroup v1
  if [ -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us ] && [ -r /sys/fs/cgroup/cpu/cpu.cfs_period_us ]; then
    q=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null)
    p=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us 2>/dev/null)
    if [ -n "$q" ] && [ "$q" -gt 0 ] 2>/dev/null && [ -n "$p" ] && [ "$p" -gt 0 ] 2>/dev/null; then
      echo $(( (q + p - 1) / p )); return
    fi
  fi
  n=$(awk '/^processor/ {n++} END {print (n ? n : 1)}' /proc/cpuinfo)
  echo "$n"
}
clamp() { v=$1; lo=$2; hi=$3; [ "$v" -lt "$lo" ] && v=$lo; [ "$v" -gt "$hi" ] && v=$hi; echo "$v"; }

MEM_MB=$(mem_limit_mb)
[ -n "$MEM_MB" ] 2>/dev/null || MEM_MB=256
[ "$MEM_MB" -lt 128 ] 2>/dev/null && MEM_MB=128

MAXMEM=$(( MEM_MB * 70 / 100 ))
[ "$MAXMEM" -lt 64 ] && MAXMEM=64
# 容器内还要留进程/复制缓冲，给上限留 128MB 或 10% 余量（取大）
RESERVE=$(( MEM_MB / 10 )); [ "$RESERVE" -lt 128 ] && RESERVE=128
[ "$MAXMEM" -gt $(( MEM_MB - RESERVE )) ] && MAXMEM=$(( MEM_MB - RESERVE ))
[ "$MAXMEM" -lt 64 ] && MAXMEM=64
[ -n "${REDIS_MAXMEMORY_MB:-}" ] && MAXMEM="${REDIS_MAXMEMORY_MB}"
POLICY="${REDIS_MAXMEMORY_POLICY:-noeviction}"

echo "[redis-autosize] mem=${MEM_MB}MB -> maxmemory=${MAXMEM}mb policy=${POLICY}" >&2
exec /usr/local/bin/docker-entrypoint.sh redis-server "${REDIS_CONF:-/usr/local/etc/redis/redis.conf}" \
  --requirepass "${REDIS_PASSWORD:?REDIS_PASSWORD required}" \
  --maxmemory "${MAXMEM}mb" \
  --maxmemory-policy "${POLICY}"
