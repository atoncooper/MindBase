# app-pay 压测基线手册（P2-6）

> 工具 = app-pay 自带 /test/pay/*（本地/测试实例：pay.test.enabled=true + PAY_TEST_TOKEN + 回环）。
> 生产实例禁用测试入口，压测永远打 test 实例（compose profile pay-test，整库隔离）。

## 0. 准备

```bash
docker compose --profile pay-test up -d app-pay-test-mysql app-pay-test
TOKEN=$(grep PAY_TEST_TOKEN .env | cut -d= -f2)   # test profile 默认 local-test-token
BASE=https://127.0.0.1:18002
```

## 1. 幂等正确性（并发同单支付只交付一次）

```bash
curl -k -X POST "$BASE/test/pay/orders" -H "Content-Type: application/json" \
  -H "X-Test-Token: $TOKEN" -d '{"uid":10086,"skuCode":"VIP_MONTHLY","channel":"MOCK"}'
# 记下 orderNo，然后 64 线程并发支付同一单：
curl -k -X POST "$BASE/test/pay/burst" -H "Content-Type: application/json" \
  -H "X-Test-Token: $TOKEN" -d '{"mode":"PAY_SAME","uid":10086,"count":64,"orderNo":"<orderNo>"}'
# 断言：stats 里 PAY:DELIVERED 恰好 1 次，其余 PAY:DELIVERED(幂等返回) 或冲突；
# DB: select status from pay_order where order_no='...' -> DELIVERED；pay_membership_event 该单仅 1 条 ACTIVATE
```

## 2. 建单吞吐（DB 写路径 + 新增闸门验证）

```bash
curl -k -X POST "$BASE/test/pay/burst" -H "Content-Type: application/json" \
  -H "X-Test-Token: $TOKEN" -d '{"mode":"CREATE_ORDERS","uid":10086,"count":500,"skuCode":"VIP_MONTHLY"}'
# 观察：elapsed_ms；超过 max-open-per-user(10) 后大量 429 属预期（闸门生效）
# 冷却闸门：同 uid 30s 内第二次建单 -> 429 ORDER_COOLDOWN；全局闸门 600/min -> 429 RISK_GLOBAL_GATE_EXCEEDED
```

## 3. 观察指标（/actuator/prometheus 或 Grafana，规则见 ops/monitoring/app-pay-alerts.rules.yml）

| 维度 | 指标 | 健康线 |
|---|---|---|
| 连接池等待 | `hikaricp_connections_pending` | = 0 |
| 连接池超时 | `hikaricp_connections_timeout_total` 增速 | = 0 |
| Tomcat 线程 | `tomcat_threads_busy` / 200 | < 70% |
| 渠道出网 | `pay_channel_query_total` / `pay_channel_create_total` 速率 | 见告警阈值 |
| 风控拦截 | `pay_risk_blocked_total`（按 reason） | 突增告警 |
| 支付/关单 | `pay_orders_paid_total` / `pay_orders_closed_total` | 业务核对 |

## 4. 基线记录表（每次压测填一行）

| 日期 | 并发 | 场景 | elapsed_ms p50/p99 | hikari pending 峰值 | tomcat busy 峰值 | 渠道 QPS 峰值 | 结论 |
|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |
