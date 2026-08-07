#!/usr/bin/env bash
# scripts/start-task.sh
# 一键启动前端 + 后端 + app-task（本地开发模式，3 个进程）
# 基础设施（mysql/mongo/redis/APISIX/XXL-JOB）请自行启动，例如：
#   docker compose up -d mysql mongo redis
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
mkdir -p logs
PID_FILE="$PROJECT_ROOT/logs/.task-stack.pids"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log_info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}   $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }

# Already running?
if [ -f "$PID_FILE" ]; then
    log_warn "PID file exists. Run ./scripts/stop-task.sh first, or remove $PID_FILE"
    exit 1
fi

# Try conda (optional; fall back to current python)
CONDA_ENV="mind-base"
if command -v conda >/dev/null 2>&1; then
    eval "$(conda shell.bash hook 2>/dev/null)"
    conda activate "$CONDA_ENV" 2>/dev/null || log_warn "conda env '$CONDA_ENV' not found, using current python"
fi

# 1. backend (uvicorn app.main:app :8000)
log_info "Starting backend (uvicorn :8000)..."
nohup python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 \
    > logs/backend.log 2>&1 &
BACKEND_PID=$!

# 2. app-task (uvicorn main:app --app-dir app-task :8001)
log_info "Starting app-task (uvicorn :8001)..."
nohup python -m uvicorn main:app --app-dir app-task --host 127.0.0.1 --port 8001 \
    > logs/app-task.log 2>&1 &
APPTASK_PID=$!

# 3. frontend (npm run dev :3000)
log_info "Starting frontend (npm run dev :3000)..."
(cd frontend && nohup npm run dev > ../logs/frontend.log 2>&1 &)
FRONTEND_PID=$(pgrep -P $! 2>/dev/null || echo "")
# fallback: find most recent next dev process
if [ -z "$FRONTEND_PID" ]; then
    FRONTEND_PID="unknown"
fi

echo "$BACKEND_PID $APPTASK_PID $FRONTEND_PID" > "$PID_FILE"

# Wait for ports
wait_port() {
    local port=$1 name=$2 pid=${3:-}
    for i in $(seq 1 40); do
        sleep 1
        if command -v lsof >/dev/null 2>&1; then
            lsof -i :"$port" >/dev/null 2>&1 && { log_ok "$name ready at :$port"; return 0; }
        elif command -v ss >/dev/null 2>&1; then
            ss -tln | grep -q ":$port " && { log_ok "$name ready at :$port"; return 0; }
        fi
    done
    log_error "$name not ready within 40s (check logs/$name.log)"
    return 1
}
wait_port 8000 backend "$BACKEND_PID" || exit 1
wait_port 8001 app-task "$APPTASK_PID" || exit 1
wait_port 3000 frontend || exit 1

echo ""
log_ok "Stack started (local dev):"
echo -e "  ${CYAN}Frontend${NC}  http://localhost:3000"
echo -e "  ${CYAN}Backend${NC}   http://localhost:8000/docs"
echo -e "  ${CYAN}app-task${NC}  http://localhost:8001/docs"
echo ""
log_info "PIDs: backend=$BACKEND_PID  app-task=$APPTASK_PID  frontend=$FRONTEND_PID"
log_info "Logs: logs/backend.log  logs/app-task.log  logs/frontend.log"
log_info "Stop: ./scripts/stop-task.sh"
log_warn "Infra (mysql/mongo/redis/APISIX/XXL-JOB) NOT started by this script - run separately."
