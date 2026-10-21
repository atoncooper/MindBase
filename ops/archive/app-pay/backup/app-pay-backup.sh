#!/usr/bin/env bash
# app-pay 备份脚本（P2-14）：MySQL 全量 dump + 审计 JSONL 拷贝，按天轮转保留。
# 用法: ./app-pay-backup.sh [BACKUP_DIR]   （默认 ./backups，保留 30 天）
# 调度: crontab -> 30 2 * * * /path/to/app-pay-backup.sh >> /var/log/app-pay-backup.log 2>&1
set -euo pipefail

BACKUP_DIR="${1:-./backups}"
RETENTION_DAYS=30
STAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

echo "[app-pay-backup] start $STAMP"

# 1) MySQL 逻辑全量（app_pay 库；恢复演练见 README.md）
docker exec mind-base-app-pay-mysql sh -c \
  'exec mysqldump -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" --single-transaction --routines --triggers app_pay' \
  | gzip > "$BACKUP_DIR/app_pay_$STAMP.sql.gz"

# 2) 资金审计 JSONL（pay-audit.jsonl 当日文件；历史 .gz 由 logback 轮转，同样拷贝目录）
docker cp mind-base-app-pay:/app/logs/pay-audit.jsonl "$BACKUP_DIR/pay-audit_$STAMP.jsonl" 2>/dev/null \
  || echo "[app-pay-backup] WARN: pay-audit.jsonl not found (容器未启动?)"

# 3) 轮转清理
find "$BACKUP_DIR" -name 'app_pay_*.sql.gz' -mtime +$RETENTION_DAYS -delete
find "$BACKUP_DIR" -name 'pay-audit_*.jsonl' -mtime +$RETENTION_DAYS -delete

echo "[app-pay-backup] done -> $BACKUP_DIR"
ls -lh "$BACKUP_DIR" | tail -n 5
