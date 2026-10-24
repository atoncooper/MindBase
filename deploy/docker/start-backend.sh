#!/usr/bin/env bash
# ================================================================
# server2（数据层 + 后端）一键启动：数据层 -> milvus -> Go服务/MCP -> 支付/任务/AI
# 前提：../../ 下已有 .env、secrets/、app-pay/certs/、app-board/certs/（从 server1 拷贝）
#       swarm worker 已加入；overlay 可见（docker network ls | grep mind-base-overlay）
# 可选：90-higress（.env 未指向外部网关时）、95-app-pay-admin、96-app-admin
#
# 用法：bash start-backend.sh [--pull]
#   --pull  先从镜像仓库拉取各服务最新镜像再 up（合并代码后更新容器用）。
#           默认不拉取——所有服务 pull_policy: missing，本机已有旧 :latest 时
#           up -d 不会更新，必须显式 pull 才会以新镜像重建容器。
# ================================================================
set -uo pipefail
cd "$(dirname "$0")"

PULL=0
for a in "$@"; do [ "$a" = "--pull" ] && PULL=1; done

[ -e .env ] || ln -sf ../../.env .env

# depends_on 只在同一台主机/同一 compose project 内生效，跨机依赖（server1 的
# minio/apisix）用它探测：在 overlay 里起一次性容器轮询远端 /health，收到任意
# HTTP 响应（含 404，如 apisix 无兜底路由）即视为"远程依赖完成"。超时只告警
# 不阻断——运行时另有 APISIX 主动健康检查 + 应用内 fail-open 自愈。
CURL_IMAGE="${WAIT_CURL_IMAGE:-curlimages/curl:8.11.1}"

wait_http() { # url [超时秒]
  local url="$1" t="${2:-180}"
  printf '[wait-http] %-46s ' "$url"
  if docker run --rm --network mind-base-overlay "$CURL_IMAGE" \
      timeout "$t" sh -c 'until curl -s -o /dev/null --max-time 4 "$1"; do sleep 3; done' _ "$url" 2>/dev/null; then
    echo "OK"; return 0
  fi
  echo "TIMEOUT(${t}s) —— overlay 内不可达（安全组 4789/udp、7946/tcp+udp、2377/tcp；对端服务是否已起）"; return 0
}

docker network inspect mind-base-overlay >/dev/null 2>&1 \
  || echo "⚠️  overlay 网络 mind-base-overlay 不存在（server1: docker network create -d overlay --attachable mind-base-overlay）"

for p in ../../.env ../../secrets/api_key_encryption_key ../../app-pay/certs ../../app-board/certs; do
  [ -e "$p" ] || echo "⚠️  缺少 $p —— 请从 server1 拷贝（app-pay/app-board 缺证书会拒启）"
done

up() {
  if [ "$PULL" = "1" ]; then
    printf '[pull]  %s\n' "$2"
    docker compose --env-file ../../.env -f "$1" pull "$2" \
      || echo "⚠️  $2 镜像拉取失败（Hub 不可达？）——继续使用本地镜像"
  fi
  docker compose --env-file ../../.env -f "$1" up -d "$2"
}

wait_ready() {
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

echo "==> [1/4] 数据层"
up 20-redis.yml redis;                          wait_ready mind-base-redis
up 21-mongo.yml mongo;                          wait_ready mind-base-mongo
up 22-neo4j.yml neo4j;                          wait_ready mind-base-neo4j 180
up 24-app-task-mysql.yml app-task-mysql;        wait_ready mind-base-app-task-mysql
up 25-app-pay-mysql.yml app-pay-mysql;          wait_ready mind-base-app-pay-mysql

echo "==> [1.5/4] 远程依赖门（server1 边缘层：minio / apisix —— 跨机 depends_on 等价物）"
wait_http http://minio:9000/minio/health/live 300
wait_http http://apisix:9080/ 300

echo "==> [2/4] Milvus（etcd/minio 走 overlay 连 server1）"
up 23-milvus.yml milvus
sleep 10   # milvus 无健康检查，给初始化留时间

echo "==> [3/4] Go 服务 + MCP"
for f in 30-app-auth 31-app-bili 32-app-note 33-app-quiz 34-app-cloud 35-app-kg 36-app-settings 37-app-board 38-app-board-mcp 39-app-note-mcp 40-app-quiz-mcp; do
  up "$f.yml" "${f#*-}"
done
wait_ready mind-base-app-auth 120
wait_ready mind-base-app-bili 120
wait_ready mind-base-app-board-mcp 60

echo "==> [4/4] 支付 / 任务 / AI 核心"
up 42-app-pay.yml app-pay;                      wait_ready mind-base-app-pay 240
up 41-app-task.yml app-task;                    wait_ready mind-base-app-task 60
up 43-app-ts.yml app-ts;                        wait_ready mind-base-app-ts 180

echo
echo "✅ server2 后端完成（可选：90-higress / 95-app-pay-admin / 96-app-admin 单独 up）"
echo "   验证跨机解析：docker exec mind-base-app-ts getent hosts minio"
docker ps --format 'table {{.Names}}	{{.Status}}'
