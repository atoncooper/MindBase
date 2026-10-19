# app-pay — 交易 / 会员服务

> 独立 Java 21 + Spring Boot 3 微服务：会员 SKU、订单、支付渠道、会员态。agent 无关、无用户交互；鉴权由 APISIX 统一承担，本服务信任网关注入的 `X-Uid`。

## 定位

| 维度 | 说明 |
|------|------|
| 技术栈 | Java 21 + Spring Boot 3.5 + MyBatis-Plus 3.5（手写 SQL 一律在 `resources/mapper/*.xml`）+ Alipay SDK |
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

## 安全加固（2026-10）

### 权限与资金控制

- **内部密钥分权**：APISIX 拆分 consumer —— `/internal/pay/membership/*`（读）接受共享 `internal` 或 `pay-readonly`；
  `/internal/pay/grant`、`/internal/pay/orders/*`（退款/reject）、`/internal/pay/refund-requests` 仅接受 `pay-ops`
  （`consumer-restriction` 白名单）。`PAY_OPS_KEY` 只存 .env，不下发任何业务容器 —— 共享密钥泄漏不再等于资金权限泄漏。
- **退款双人复核（maker-checker）**：`pay.refund.require-approval=true`（docker profile）时，refund 第一次调用只登记
  `PENDING` 审批（operator=maker，`pay_refund_approval` 表），第二操作人携 `confirm=true` 再次调用（服务端强制
  `checker != maker`）才进入渠道退款；`POST .../refund/reject` 驳回；`GET /internal/pay/refund-requests?status=PENDING` 查询。
  系统自动退款（档位墙自动退）为机器动作，凭审计绕过复核。本地/测试形态 `require-approval=false` 直接退款。
- **ADMIN_GRANT 日额度熔断**：`pay.grant.daily-max-count / daily-max-days`（本地自然日，按 `(type, created_at)` 索引聚合），
  超限 429 + `GRANT_DAILY_*_EXCEEDED` 审计 —— 内部密钥泄漏也无法批量薅会员。
- **入参防日志伪造**：所有 `orderNo` 入参（DTO + `@PathVariable`）加 `@Pattern("^PO[A-Za-z0-9]{1,62}$")`。

### 数据与纵深

- **审计哈希链**：`pay-audit.jsonl` 每行携带 `chain/prev/hash`（SHA-256 链），启动从磁盘最后一条续链，跨重启不断链；
  改动历史行会破坏后续全部可验证性。多实例分叉按 chain id 分组校验（单实例为完整链）。
- **买家信息掩码**：`OrderView` 的 `buyerLogonId/buyerUserId` 统一掩码；DB 与 app-pay-admin（直连库）保留全值。
- **支付频次风控**：`pay.risk.max-paid-orders-per-day / max-paid-amount-per-day-cents`（滚动 24h，下单时拦截，
  429 `RISK_VELOCITY_EXCEEDED` + `RISK_VELOCITY_BLOCKED` 审计）。
- **CI 漏洞门禁**：`ci-app-pay.yml` 增加 Trivy 依赖扫描（HIGH/CRITICAL 红）；`.github/dependabot.yml` 每周自动升级 PR。
- **上游 TLS verify**：APISIX 3.11 不支持普通 https upstream 证书校验（见 upstream-app-pay 注释），已挂 `TODO(security)`，
  升级后翻 `verify:true` 并收紧 `https_verify_certificate`。
- **备份与演练**：`ops/backup/app-pay-backup.sh`（MySQL dump + 审计 JSONL，30 天轮转）+ `ops/backup/README.md` 恢复演练清单。

## 高并发加固（2026-10）
## （V5 索引：idx_pay_order_uid_status_paid / idx_pay_order_uid_created / idx_pay_order_status_created —— 频次检查 ICP、订单列表免 filesort、补单扫描免回表；交付事务 READ_COMMITTED 消除首购间隙锁死锁面；接受相事务折叠 fsync 4→3/笔）

- **查单退避**：`GET /pay/orders/{no}` 的服务端渠道查单从固定 3s 改为指数退避 3s→6s→12s→24s 封顶
  （`OrderService`），前端轮询同步退避 2.5s→5s→7.5s→10s（membership-view）—— 1000 并发支付者的渠道查询
  QPS 约 330 → 约 40，消除"限频→未支付→更密轮询"死亡螺旋。`notify_url` 上线后（`ALIPAY_NOTIFY_URL`，需公网可达）
  回调成为主路径，轮询仅兜底。
- **timer 注册异步化**：afterCommit 只投递到有界线程池（`pay.apptask.register-threads=2` /
  `register-queue-capacity=1000`），出网 HTTP 不再占用请求线程；队列满 warn+审计，兜底轮询接管。
- **池与线程显式配置**：`server.tomcat.threads.max=200`；Hikari 池由 `pay.rdbms.pool-size=20` 控制
  （DataSourceConfig 手工建池，启动断言 executor-workers <= pool-2），connection-timeout 5s fail-fast。
- **Job 并行化**：`pay.job.scan-limit=200`（原 50），ChannelQueryJob/OrderTimeoutJob 每单处理在 8 线程
  `payJobQueryExecutor` 并行出网；DeliveryRetryJob 保持串行（DB 事务）但上限同步提升。
- **下单闸门三层**：全局每分钟建单上限（`pay.risk.global-orders-per-minute=600`，单实例计数）+ 同 uid
  冷却（`order-cooldown-seconds=30`）+ 滚动 24h 支付频次（已有），全部 429 + `pay_risk_blocked_total{reason}` 指标。
  多实例说明：闸门/冷却/查单节流均为单实例内存态（强度 = 配置值 × 实例数）；JobLease 已保证 job 不翻倍；
  Redis 集中化评估结论 —— 当前 1~3 实例规模下收益不抵新依赖，暂缓（触发条件：实例数 >3 或出现跨实例滥用）。
- **PAY_EXECUTOR_TOKEN**：已激活（.env），超时执行器直连调用的唯一鉴权；旧注册定时器回调 401 由兜底轮询关单。
- **告警与压测**：`ops/monitoring/app-pay-alerts.rules.yml`（对账差异/回调拒绝/渠道 QPS/风控激增/Hikari 饱和）+
  `ops/loadtest/app-pay-loadtest.md` 压测基线手册（/test/pay/burst 幂等与吞吐场景）。

## pay-admin 退款复核工作台（2026-10）

- **退款审批工作台**：pay-admin 新增"退款复核"页（admin only）——待审列表直读 `pay_refund_approval`，
  approve/reject 经 APISIX（pay-ops consumer，`PAY_OPS_KEY`）调 app-pay 的 internal 端点执行；
  **operator = 控制台登录账号（服务端注入）**，替代 curl 自报身份；maker != checker 由 app-pay 强制。
  `PAYADMIN__APP_PAY__OPS_KEY` 未配置时整组 404 隐藏；密钥只注入 pay-admin 容器（compose fail-closed）。
- **REFUND_HOLD 冻结单**：订单筛选/状态映射补齐（红色标记），冻结单经退款复核流人工处理。
- **Grant 额度对齐**：pay-admin 直写 DB 原本绕过 app-pay 的日额度执行点——Grant 现在执行同一熔断
  （`PAYADMIN__GRANT__DAILY_MAX_COUNT=50` / `DAILY_MAX_DAYS=1000`，按 (type,created_at) 聚合），超限 429 + 审计；
  统计查询失败 fail-open（不阻塞资金写，留 WARN）。
- **网络安全**：审计 JSONL 哈希链（chain/prev/hash，跨重启续链）对齐 app-pay；安全响应头
  （nosniff/frame-ancestors 'none'/no-referrer）与 cookie SameSite=Strict+HttpOnly 为既有实现（本次核对确认）。
- **明确不做**：退款/关单/SKU 改价的直接 DB 写（红线不变）；会话存储仍是内存态（重启即下线，控制台规模可接受）。

## 升级换购（同档补差价，2026-10）

**语义**：会员有效期内，可对同档位更长周期 SKU「补差价升级」。

- **差价**：应付金额 = 新 SKU 价 − 基准订单实付价（基准 = 会员 `last_order_no` 对应的 DELIVERED 订单）；
- **时长**：交付在原到期日上顺延「新 SKU 天数 − 基准单天数」→ 总时长 = 从原购买日起的新套餐全长，已用天数不浪费；
- **条件**：新 SKU 时长与价格均严格高于基准单；降档仍拒绝（`TIER_DOWNGRADE_BLOCKED`）；跨档（如 VIP → SVIP）为全价购买，原剩余时长保留；
- **链式升级**：升级单交付后 `last_order_no` 自动切换为升级单，可再次按新基准升级（每次只补相邻差价，自我一致无套利）；
- **约束**：同一会员同时仅允许一张待支付升级单（`UPGRADE_ORDER_PENDING`）；赠送/人工开通的会员无基准单，走人工流程（`UPGRADE_BASE_INVALID`）；
- **档位墙豁免**：升级单支付确认时豁免第二道墙（同档按设计交付），权益事件标记 `UPGRADE`；
- **接口**：`GET /pay/upgrade-quotes`（报价，前端商品卡展示差价）；建单复用 `POST /pay/orders`（服务端按同一公式计价，前端零信任）。


## Let's Encrypt 证书存储路径（常见坑，2026-10）

certbot Docker 容器有**两个目录**，不要混淆：
- `/var/www/certbot` — ACME webroot 验证文件（临时 challenge 文件）
- `/etc/letsencrypt` — **签发的证书和私钥**（fullchain.pem / privkey.pem）

用 `docker run --rm` 跑 certbot 时如果没挂载 `/etc/letsencrypt`，证书随容器删除而丢失。
正确做法：同时挂载两个卷，续期脚本用 `--keep-until-expiring`。