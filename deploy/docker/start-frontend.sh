#!/usr/bin/env bash
# ================================================================
# server1（边缘层）一键启动：证书 -> etcd -> minio -> apisix -> frontend -> nginx
# 前提：仓库在本机 deploy/docker 的上两级（../../）；swarm 已建；overlay 已创建
#   docker network create -d overlay --attachable mind-base-overlay
# ================================================================
set -uo pipefail
cd "$(dirname "$0")"

# compose 插值变量来自 .env（软链到仓库根）
[ -e .env ] || ln -sf ../../.env .env

up() { docker compose --env-file ../../.env -f "$1" up -d "$2"; }

wait_ready() { # 容器名 [超时秒]
  local c="$1" t="${2:-180}" i=0 st=""
  printf '[wait] %-28s ' "$c"
  while [ "$i" -lt "$t" ]; do
    st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || echo missing)
    case "$st" in
      healthy|running) echo "OK ($st)"; return 0 ;;
    esac
    sleep 3; i=$((i+3))
  done
  echo "TIMEOUT(last=$st) —— docker logs $c 排查"; return 0
}

echo "==> [1/6] 证书（Subject 完整；改 MB_CERT_HOST 后自动按新 SAN 重签，或 MB_CERT_FORCE=1 全量重签）"
docker compose --env-file ../../.env -f 00-certs.yml up cert-gen

echo "==> [2/6] etcd"
up 11-etcd.yml etcd;                 wait_ready mind-base-etcd

echo "==> [3/6] minio"
up 12-minio.yml minio;               wait_ready mind-base-minio

echo "==> [4/6] apisix"
up 13-apisix.yml apisix;             wait_ready mind-base-apisix 120

echo "==> [5/6] frontend"
up 10-frontend.yml frontend;         wait_ready mind-base-frontend 120

echo "==> [6/6] nginx"
up 14-nginx.yml nginx;               wait_ready mind-base-nginx 60

echo
echo "✅ server1 边缘层完成。"
echo "   浏览器不弹警告：把 nginx/certs/dev-ca.crt 导入系统/浏览器『受信任的根证书颁发机构』"
echo "   （Subject/SAN 由 .env 的 MB_CERT_HOST / MB_CERT_EXTRA_SAN 控制）"
docker ps --format 'table {{.Names}}	{{.Status}}	{{.Ports}}'
