# app-pay — 交易 / 会员服务

> 独立 Java 17 + Spring Boot 3 微服务：会员 SKU、订单、支付渠道、会员态。agent 无关、无用户交互；鉴权由 APISIX 统一承担，本服务信任网关注入的 `X-Uid`。

## 定位

| 维度 | 说明 |
|------|------|
| 技术栈 | Java 17 + Spring Boot 3.5 + MyBatis-Plus 3.5（手写 SQL 一律在 `resources/mapper/*.xml`）+ Alipay SDK |
| 端口 | 生产 8002（profile `docker`）；测试 18002（profile `test`）。compose 仅回环暴露（`127.0.0.1`），须经 APISIX 访问 |
| 数据库 | 独立 MySQL `app_pay`（`app-pay-mysql` 容器，宿主 3307）；`schema.sql` 启动幂等自建 |
| 会员号 | 即主 app `users.uid`（BigInteger 全局唯一，无跨库外键） |
| 金额 | 一律 `long` 分，禁浮点；回调金额以本地订单为准（不信渠道回传值） |
| 传输 | **HTTPS-only（含本地）**：`server.ssl` 挂 PEM；证书缺失启动自检拒绝启动 |
| 日志 | `[PAY]` 前缀 + traceId 贯穿（响应回写 `X-Trace-Id`）+ 资金审计 JSONL（`logs/pay-audit.jsonl`，365 天） |

## 订单状态机

```
CREATED ──条件更新──► PAID ──交付(会员顺延,同事务)──► DELIVERED
   │                                                    │ 交付失败回滚留 PAID
   │ 超时关单：app-task 精确定时委托(trigger_time=expires_at)      ▼ DeliveryRetryJob 补偿
   │   /internal/pay/timeout/execute（payload 带 version，    DeliveryRetryJob 重试
   │   不匹配=已支付，委托作废；队列满 503 → app-task 退避重试）
   │ 兜底：OrderTimeoutJob(抖动+空跑退避, 超 30min 关单)
   └──► CLOSED            已支付后关单 → 无条件重开交付（ORDER_REOPENED 审计）
```

- 所有状态流转**条件更新**（`WHERE status=...`），绝不读改写
- 回调幂等：条件更新 + `channel_trade_no` / `idempotency_key` 唯一键；PAID 期间重复回调触发自愈补交付
- 兜底轮询三任务（`JitteredBackoffTrigger` ±30% 抖动 + 空跑退避）：`OrderTimeoutJob`（120s）、`DeliveryRetryJob`（60s）、`ChannelQueryJob`（60s 主动查单）

## 支付渠道

| 渠道 | 状态 | 说明 |
|------|------|------|
| MOCK | ✅ M1 | `POST /pay/mock/confirm` 模拟支付；生产 docker profile 固化 `pay.mock.enabled=false` |
| 支付宝当面付 | ✅ M2（沙箱） | `precreate` 二维码下单 + 主动查单 + 异步通知 RSA2 验签；`ALIPAY_*` 凭证齐备才启用（缺失拒绝启动）；默认沙箱网关，docker profile 用生产网关；`ALIPAY_NOTIFY_URL` 留空 = 纯查单模式 |
| 微信 V3 | 预留 M2.5 | 枚举已留，新增 `service/channel/` ChannelAdapter 实现即可，编排/幂等/补单零改动 |

## API

### 用户端 `/pay/*`（forward-auth，信任 `X-Uid`；缺失/非法 → 401）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/pay/products` | 在售 SKU |
| POST | `/pay/orders` | 创建订单 `{skuCode, channel, idempotencyKey?}`，返回支付参数（MOCK 确认端点或支付宝二维码） |
| GET | `/pay/orders/{orderNo}` | 订单详情（uid 归属校验，非本人 404 防越权） |
| GET | `/pay/membership` | 当前用户会员态（懒过期：`expire_at > now`） |
| POST | `/pay/mock/confirm` | 模拟支付（仅 MOCK 渠道开启时） |

### 渠道回调

`POST /pay/callback/alipay`：form-urlencoded 异步通知，RSA2 验签，应答文本 `success`/`fail`；APISIX 免登录路由。

### 服务间 `/internal/pay/*`（APISIX key-auth，`apikey` 头）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/internal/pay/membership/{uid}` | 主 app 查会员态（非会员 `active:false`，不报错）；M3 接入后主 app 侧短 TTL 缓存，**主 app/前端禁止直读 `pay_*` 表** |
| POST | `/internal/pay/grant` | 运营补偿开通 `{uid, durationDays, reason(必填)}` → `ADMIN_GRANT` 审计事件 |
| POST | `/internal/pay/timeout/execute` | app-task 超时委托执行器：入队（容量 10000、8 worker），满则 503 `EXECUTOR_BUSY` 由 app-task 退避重试 |

### 测试入口 `/test/pay/*`

三重闸门：`pay.test.enabled`（false 时全部 404 隐身）+ `X-Test-Token` 令牌 + 结构性隔离（APISIX 不路由 `/test/*`、端口回环绑定）。提供任意 uid 下单/mock 支付/查单/服务端并发 burst（`/test/pay/burst`）/二维码渲染等；配套控制台 `pay-console.html` 与冒烟脚本 `app-pay/scripts/smoke.sh`。**生产/对外环境必须 `enabled=false`**（docker profile 已固化）。

## 配置

配置唯一入口 `application.yaml`，环境差异用 profile 变体（compose `command: --spring.profiles.active=docker|test` 激活）；敏感值经 `${VAR:默认}` 占位符引用环境变量。

**.env 加载**：容器形态由 compose `env_file` 注入；本地直启由 `PayDotenvEnvironmentPostProcessor`（spring.factories 注册）从工作目录向上找项目根 `.env` 注入，优先级 **真实环境变量 > .env > yaml 默认值**。

关键环境变量（详见 `.env.example` app-pay 段）：

```bash
PAY_MYSQL_USER=app_pay            # 库 app_pay；PAY_MYSQL_PASSWORD=app-pay；宿主端口 3307
ALIPAY_ENABLED / ALIPAY_APP_ID / ALIPAY_APP_PRIVATE_KEY / ALIPAY_PLATFORM_PUBLIC_KEY
ALIPAY_GATEWAY_URL / ALIPAY_NOTIFY_URL
PAY_TLS_ENABLED=true              # 应急逃生 false 仅限本机排查
PAY_TLS_CERT / PAY_TLS_KEY        # 缺省 certs/pay.crt|key
PAY_TEST_TOKEN=...                # 测试入口令牌
APISIX_CONSUMER_KEY=...           # 服务间 key-auth 密钥（与 app-task/主 app 一致）
APP_PAY_PORT=8002 / APP_PAY_TEST_PORT=18002 / APP_PAY_IMAGE=...
```

**TLS 证书**：`app-pay/scripts/gen-dev-cert.sh|.ps1` 生成 mini-CA + 叶子证书到 `app-pay/certs/`（gitignored；SAN 覆盖 localhost/127.0.0.1/::1/app-pay/app-pay-test）。APISIX 的 `upstream-app-pay` 走 https（自签阶段 `verify: false` 只加密不验身份）；app-task 侧委托回调经 `PAY_EXECUTOR_CA_FILE`（→ `APPTASK__HTTP_EXECUTOR__CA_FILE`）严格校验。

**环境自检**：`EnvSummaryRunner` 启动打印 tls/cert/test-mock 状态，拒绝「测试入口 × 真实渠道」同开、拒绝证书缺失。

## 启动

```bash
# 生产实例（docker profile）
docker compose --profile pay up -d --build app-pay-mysql app-pay

# 测试实例（整库隔离 + 强制 MOCK；测试控制台只能走这个实例）
docker compose --profile pay-test up -d app-pay-test-mysql app-pay-test

# 本地直启（workdir app-pay/）
mvn spring-boot:run
```

## 审计与日志

- **资金审计 JSONL**：`PayAuditLogger` → `logs/pay-audit.jsonl`（365 天），事件覆盖 ORDER_CREATED / ORDER_PAID / ORDER_PAID_DUPLICATE / ORDER_REOPENED / AMOUNT_MISMATCH / CALLBACK_REJECTED / MEMBERSHIP_EXTENDED / TIMER_REGISTER_FAILED / TEST_* 等
- **权益事件表**：`pay_membership_event`（ACTIVATE / RENEW / ADMIN_GRANT / REFUND_REVOKE），含 days、expireBefore/After、reason
- **回调留痕**：`pay_callback_log`（报文脱敏）
- 密钥与验签原文不落日志

## 测试

```bash
cd app-pay && mvn test    # 20 个测试类 / 86 个用例，纯 JUnit 无外部 DB
```

覆盖重点：支付幂等竞态（`markPaidWinsThenDelivers`、`paidAfterCloseReopensAndDelivers`、金额不符拒绝）、订单 idempotency、会员顺延/过期起算、支付宝适配器、测试入口闸门、抖动退避、委托队列、dotenv 加载、mapper XML 一致性守护。

详细设计文档：`plan/1.0.7-Pay/1.0.7-Pay.md`（本地文档，不入 git）。
