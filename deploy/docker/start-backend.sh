#!/usr/bin/env bash
# ================================================================
# server2（数据层 + 后端）一键启动：数据层 -> milvus -> Go服务/MCP -> 支付/任务/AI
# 前提：../../ 下已有 .env、secrets/、app-pay/certs/、app-board/certs/（从 server1 拷贝）
#       swarm worker 已加入；overlay 可见（docker network ls | grep mind-base-overlay）
# 可选：90-higress（.env 未指向外部网关时）、95-app-pay-admin
# ================================================================
set -uo pipefail
cd "$(dirname "$0")"

[ -e .env ] || ln -sf ../../.env .env

for p in ../../.env ../../secrets/api_key_encryption_key ../../app-pay/certs ../../app-board/certs; do
  [ -e "$p" ] || echo "⚠️  缺少 $p —— 请从 server1 拷贝（app-pay/app-board 缺证书会拒启）"
done

up() { docker compose --env-file ../../.env -f "$1" up -d "$2"; }

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
echo "✅ server2 后端完成（可选：90-higress / 95-app-pay-admin 单独 up）"
echo "   验证跨机解析：docker exec mind-base-app-ts getent hosts minio"
docker ps --format 'table {{.Names}}	{{.Status}}'
