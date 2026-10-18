# app-pay 备份与恢复演练（P2-14）

## 备份内容

| 对象 | 方式 | 频率 |
|---|---|---|
| `app_pay` MySQL 库（订单/会员/事件/审批/回调日志） | `mysqldump --single-transaction`（不锁表） | 每日 |
| `pay-audit.jsonl` 资金审计 | docker cp 拷出 + logback 历史轮转件 | 每日 |

脚本：`app-pay-backup.sh`（bash + docker exec，保留 30 天）。
Windows 宿主可用 `schtasks /create /tn app-pay-backup /tr "bash /path/app-pay-backup.sh D:/backups" /sc daily /st 02:30`。

## 恢复演练（每季度至少一次，恢复到 `app_pay_drill` 库验证）

1. 建演练库并导入：
   ```bash
   docker exec -i mind-base-app-pay-mysql sh -c \
     'exec mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" -e "CREATE DATABASE IF NOT EXISTS app_pay_drill"'
   gunzip -c backups/app_pay_<STAMP>.sql.gz | \
     docker exec -i mind-base-app-pay-mysql sh -c \
       'exec mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" app_pay_drill'
   ```
2. 核对行数与最近订单：
   ```sql
   SELECT COUNT(*) FROM app_pay_drill.pay_order;
   SELECT order_no, status, amount_cents, paid_at FROM app_pay_drill.pay_order ORDER BY id DESC LIMIT 5;
   SELECT COUNT(*) FROM app_pay_drill.pay_refund_approval WHERE status = 'PENDING';
   ```
3. 抽查最近 5 笔 `PAID/DELIVERED` 单与 `pay_membership_event` 对得上；
4. 验证审计 JSONL 尾部 `hash` 与 `prev` 链是否连续（ `jq -s 'last.hash == .[-2].hash'` 类校验脚本可后续脚本化）；
5. 记录演练结果（日期/负责人/偏差），演练未做视同没有备份。
