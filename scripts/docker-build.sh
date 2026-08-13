#!/usr/bin/env bash
# scripts/docker-build.sh
# 构建 MindBase Docker 镜像并清理悬空镜像（dangling images）
#
# 自建镜像使用固定 tag（:latest），每次重新构建时旧镜像失去 tag 变为
# <none>:<none> 悬空镜像并堆积占盘。本脚本在构建完成后自动执行
# `docker image prune -f` 清理悬空镜像（不影响有 tag 的镜像）。
#
# 用法：
#   scripts/docker-build.sh            # 构建全部服务并清理
#   scripts/docker-build.sh backend    # 只构建 backend 并清理
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
log_info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}   $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

log_info "docker compose build $*"
docker compose build "$@"

log_info "清理悬空镜像: docker image prune -f"
docker image prune -f

log_ok "构建完成，悬空镜像已清理"
