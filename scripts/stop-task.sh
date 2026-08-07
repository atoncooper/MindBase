#!/usr/bin/env bash
# scripts/stop-task.sh
# 停止前端 + 后端 + app-task（本地开发模式启动的 3 个进程）
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
PID_FILE="$PROJECT_ROOT/logs/.task-stack.pids"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
log_info() { echo -e "${CYAN}[INFO]${NC} $*"; }
log_ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }

if [ ! -f "$PID_FILE" ]; then
    log_warn "No PID file ($PID_FILE). Nothing to stop."
    exit 0
fi

# PIDs: backend app-task frontend
read -r BACKEND_PID APPTASK_PID FRONTEND_PID < "$PID_FILE" 2>/dev/null || true

for name_pid in "backend:$BACKEND_PID" "app-task:$APPTASK_PID" "frontend:$FRONTEND_PID"; do
    name="${name_pid%%:*}"
    pid="${name_pid##*:}"
    if [ -n "$pid" ] && [ "$pid" != "unknown" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null && log_ok "Stopped $name (PID $pid)"
    else
        log_warn "$name: PID $pid not running (skip)"
    fi
done

rm -f "$PID_FILE"
log_ok "Stack stopped"
