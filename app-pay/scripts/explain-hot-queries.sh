#!/usr/bin/env bash
# 高并发热点 SQL 的 EXPLAIN 验证（P2 优化审计配套）。
# 用法: docker 起着 app-pay-mysql 时执行 ./explain-hot-queries.sh
# 每条查询的第二段输出 key 列 = 实际选中的索引；key = NULL 即全表扫描。
set -euo pipefail

run() {
  echo "===== $1 ====="
  docker exec mind-base-app-pay-mysql sh -c \
    'exec mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" app_pay -e "'"$2"'"' 2>/dev/null || \
  echo "(docker 或容器未运行)"
}

run "1.velocity 频次检查(建单)" "EXPLAIN SELECT COUNT(*), COALESCE(SUM(amount_cents),0) FROM pay_order WHERE uid=10086 AND paid_at >= NOW() - INTERVAL 24 HOUR AND status IN ('PAID','DELIVERED','REFUND_HOLD')"
run "2.我的订单列表"           "EXPLAIN SELECT * FROM pay_order WHERE uid=10086 ORDER BY created_at DESC LIMIT 20"
run "3.ChannelQueryJob"        "EXPLAIN SELECT * FROM pay_order WHERE status='CREATED' AND expires_at > NOW() - INTERVAL 10 MINUTE AND created_at < NOW() - INTERVAL 60 SECOND ORDER BY created_at ASC LIMIT 50"
run "4.DeliveryRetryJob"       "EXPLAIN SELECT * FROM pay_order WHERE status='PAID' AND paid_at < NOW() - INTERVAL 1 MINUTE ORDER BY paid_at ASC LIMIT 50"
run "5.OrderTimeoutJob"        "EXPLAIN SELECT * FROM pay_order WHERE status='CREATED' AND expires_at <= NOW() ORDER BY expires_at ASC LIMIT 50"
run "6.退款审批列表"           "EXPLAIN SELECT * FROM pay_refund_approval WHERE status='PENDING' ORDER BY id DESC LIMIT 200"
run "7.商品按code"             "EXPLAIN SELECT * FROM pay_product WHERE code='VIP_MONTHLY'"
run "8.商品列表"               "EXPLAIN SELECT * FROM pay_product WHERE status='ACTIVE' ORDER BY sort, id"
run "9.订单号定位"             "EXPLAIN SELECT * FROM pay_order WHERE order_no='POtest'"
run "10.grant日额度"           "EXPLAIN SELECT * FROM pay_membership_event WHERE type='ADMIN_GRANT' AND created_at >= NOW() - INTERVAL 24 HOUR"
