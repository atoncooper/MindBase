# app-pay — 交易 / 会员服务

> 独立 Java 21 + Spring Boot 3 微服务：会员 SKU、订单、支付渠道、会员态。agent 无关、无用户交互；鉴权由 APISIX 统一承担，本服务信任网关注入的 `X-Uid`。

## 定位

| 维度 | 说明 |
|------|------|
| 技术栈 | Java 21 + Spring Boot 3.5 + MyBatis-Plus 3.5（手写 SQL 一律在 `resources/mapper/*.xml`）+ Alipay SDK |
| 端口 | 生产 8002（profile `docker`）；测试 18002（profile `test`）。compose 仅回环暴露（`127.0.0.1`），须经 APISIX 访问 |
| 探活 | `/health/live`（纯进程存活，网关用）；`/health`（真实 DB 探测，readiness/告警用）；`/actuator/{health,metrics,prometheus}` |
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

### 服务间 `/internal/pay/*`（APISIX key-auth + 服务端 `X-Internal-Key` 二次校验）

> 2026-11 起：APISIX 在 key-auth/consumer-restriction 之后用 `proxy-rewrite` 注入 `X-Internal-Key`；
> app-pay 的 `InternalAuthFilter` 做常量时间比较（未配置 fail-closed 503，缺失/错误 401）。
> 这样即使同网络容器绕过网关直连 `app-pay:8002`，也无法调用开通/退款接口。
> 例外：`/internal/pay/timeout/execute` 由 app-task 直接 POST（不经 APISIX），只校验 executor token；
> docker profile 启动自检强制 `PAY_EXECUTOR_TOKEN` 非空。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/internal/pay/membership/{uid}` | 主 app 查会员态（非会员 `active:false`，不报错）；M3 接入后主 app 侧短 TTL 缓存，**主 app/前端禁止直读 `pay_*` 表** |
| POST | `/internal/pay/grant` | 运营补偿开通 `{uid, durationDays, reason(必填), tier?, requestId?}` → `ADMIN_GRANT` 审计事件；`requestId` 幂等（同一值只生效一次） |
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

## 独立测试环境（app-pay/docker-compose.test.yml + config-test.yaml）

> 仅测试用：独立 Compose project（`mindbase-pay-test`）+ 独立库 `app_pay_test` + Redis L2 + 独立卷/端口，
> 不参与生产部署；生产仍用根 `docker-compose.yml` / K8s。只需要两个文件：
> `app-pay/docker-compose.test.yml` 与 `app-pay/config-test.yaml`。

- 启动（推荐，避开 Docker NAT 下 Maven 下载慢的问题）：
  `cd app-pay && mvn -DskipTests package && docker compose -f docker-compose.test.yml up -d --build`
  （Compose 默认用 `Dockerfile.local` 复用宿主机 jar）
- 自包含构建（CI/干净机器，首次需在容器内下载 Maven 依赖）：
  把 `docker-compose.test.yml` 里的 `build.dockerfile` 从 `Dockerfile.local` 改成 `Dockerfile`，
  再执行 `docker compose -f docker-compose.test.yml up -d --build`
  （`Dockerfile` 已做 BuildKit `~/.m2` 缓存、可见下载日志、20 分钟超时失败退出）
- 访问：`https://127.0.0.1:18002`（MySQL `127.0.0.1:13307`，库 `app_pay_test`）；证书复用
  `app-pay/certs`（缺失先跑 `scripts/gen-dev-cert.ps1|sh`）。
- 配置：`config-test.yaml` 通过 `--spring.config.additional-location=file:/app/config-test.yaml`
  叠加在 `application.yaml` 上：独立库、MOCK 渠道、`/test/pay/*` 开启、关闭 app-task 注册与压测风控。
- 令牌（仅测试）：`X-Test-Token: pay-test-token`、`X-Internal-Key: pay-test-internal-key`
  （直接写在 `config-test.yaml`，compose 不再注入环境变量）。
- 测试目录结构：
  ```text
  src/test/java/com/mindbase/pay/
  ├── common/config/controller/mapper/model/scheduler/service/testutil/  # 单元/组件测试（镜像主代码包）
  ├── integration/PayIntegrationTest.java                              # Testcontainers 集成测试
  └── e2e/
      ├── support/     # PayTestConfig / PayTestHttpClient
      ├── security/    # PaySecurityTest
      ├── flow/        # PayPurchaseFlowTest + FlowMetrics
      └── performance/ # PayPerformanceTest + LoadRunner/Reporter/...
  ```
- 安全/性能测试（**Java，src/test**，不是 JS）：
  - `src/test/java/com/mindbase/pay/e2e/security/PaySecurityTest.java`：10 个安全用例
    （内部 key、测试入口 token、X-Uid、IDOR、伪造回调、退款无 key、错误不泄漏堆栈等）；
  - `src/test/java/com/mindbase/pay/e2e/flow/PayPurchaseFlowTest.java`：17 个业务闭环/接口用例
    （真实购买→交付、重复购买自动退款、运营退款回收会员、grant 幂等、取消状态机、
    未支付 51 单 429、Idempotency-Key、读/元数据接口、timeout version 守卫、MOCK QR 400）；
  - `src/test/java/com/mindbase/pay/e2e/performance/PayPerformanceTest.java`：可配置并发/预热/时长/阈值，
    输出每端点与总体的 **min/p25/p50/p75/p90/p95/p99/p99.9/p99.99/max**、QPS/OPS/RPS/TPS、并发数、
    字节吞吐、错误率/成功率/超时率/可用率、重试次数；通过 actuator/Prometheus 采集
    CPU/堆内存/GC/Hikari（活跃/空闲/等待队列/排队耗时）/Tomcat 线程与连接，并探测 TCP/TLS 建连耗时；
    场景支持 read/write/mixed/user-write/user-read/cache-miss/hot-key；`perf.ramp-threads` 可做并发爬坡并输出
    saturation 估计；network/disk 默认 actuator 不暴露，
    报告会提示用 node_exporter/docker stats。
  - 缓存：商品目录 L1(本地 5s)+Redis L2(5s)；会员读 L1(1s)+Redis L2(1s)，写路径主动失效（详见缓存章节）
  - 客户端配置：`src/test/resources/pay-test.properties`（并发、超时、连接池、阈值、请求 padding、
    进度日志间隔、错误样本数；**直接改文件读取，不做环境变量/-D 注入**）；
  - 测试日志：console + `app-pay/logs/app-tests.log`（滚动保留 14 天/500MB；含 config/start/progress/finish、
    每端点分位数表、错误聚合与样本、系统指标）；
  - 服务端调优：`config-test.yaml`（Tomcat 线程/accept-count/max-connections、Hikari pool-size、
    form/header buffer 等），改完 `docker compose -f docker-compose.test.yml restart app-pay-test`。
  - 运行：
    `mvn test -Dtest=PaySecurityTest`；
    先把 `pay-test.properties` 的 `perf.enabled` 改成 `true`（并按需改 threads/duration），再 `mvn test -Dtest=PayPerformanceTest`。
    服务未启动时安全/性能测试自动跳过；性能测试默认关闭，避免普通 `mvn test` 跑长压测。
- 测试：`cd app-pay && mvn test`（38 个测试类 / 245 用例：244 执行 + 性能测试默认 skipped；单测 + 10 个安全用例 + 17 个业务流/接口用例 + 8 集成；
  安全/性能用例需要测试环境已启动，未启动自动跳过；性能用例默认关闭）。
- 清理：`docker compose -f docker-compose.test.yml down`；加 `-v` 连隔离数据卷一起删除。
- Dockerfile 优化（2026-11）：多阶段构建改用 BuildKit `~/.m2/repository` 缓存挂载、去掉容易“假死”的
  `dependency:go-offline`、保留 20 分钟超时并让 Maven 下载日志可见、`-Dmaven.test.skip=true` 跳过测试编译；
  `.dockerignore` 排除 `certs/logs/src/test` 与非 jar 的 `target`，避免私钥/垃圾文件进上下文。
  `Dockerfile` 已实际构建验证 BUILD SUCCESS；重复构建命中缓存。Docker Desktop NAT 下首次下载依赖可能很慢，
  因此测试环境默认用 `Dockerfile.local`（宿主机 mvn 打包后复用）。

## 审计与日志

- **资金审计 JSONL**：`PayAuditLogger` → `logs/pay-audit.jsonl`（365 天），事件覆盖 ORDER_CREATED / ORDER_PAID / ORDER_PAID_DUPLICATE / ORDER_REOPENED / AMOUNT_MISMATCH / CALLBACK_REJECTED / MEMBERSHIP_EXTENDED / TIMER_REGISTER_FAILED / TEST_* 等
- **权益事件表**：`pay_membership_event`（ACTIVATE / RENEW / ADMIN_GRANT / REFUND_REVOKE），含 days、expireBefore/After、reason
- **回调留痕**：`pay_callback_log`（报文脱敏）
- 密钥与验签原文不落日志

## 测试

```bash
cd app-pay && mvn test    # 38 个测试类 / 245 个用例（244 执行 + 性能测试默认 skipped；含 10 个安全用例、17 个业务流/接口用例；
                          # 集成/安全/性能用例需要 Docker 与 docker-compose.test.yml 测试环境）
```

覆盖重点：支付幂等竞态（`markPaidWinsThenDelivers`、`paidAfterCloseReopensAndDelivers`、金额不符拒绝）、订单 idempotency、会员顺延/过期起算、支付宝适配器、测试入口闸门、抖动退避、委托队列、dotenv 加载、mapper XML 一致性守护。

2026-11 P0/P1 回归补充：
- **服务侧鉴权**：`InternalAuthFilterTest`（未配置 503 / 缺失错误 401 / 正确放行 / executor 豁免 / 指标）+ 集成 `internalEndpointRequiresInternalKey`。
- **资金竞态**：`DeliveryServiceTest`（同档冻结、过期/跨档/升级放行、legacy null tier、冻结未命中仍拦截）、`RefundServiceTest`（并发交付后按 `refund_prev_status` 回收、重复 PENDING、双人复核条件更新竞态）、`PaymentServiceTest`（唯一交付入口 TIER_BLOCKED 自动退款、自愈路径、SKIPPED 重读）。
- **并发/额度**：集成 `concurrentOrderCreationRespectsOpenOrderCap`（20 线程精确 10 单）、`secondSameTierPurchaseIsAutoRefundedNotDelivered`、`grantIsIdempotentAndQuotaCountedOnce`、`grantDailyQuotaRejectsOverLimit`（含幂等占位回滚）。
- **运维契约**：`GatewayConfigRegressionTest` 守住 APISIX 内部 key 注入/no-retry 上游/`/health/live`/回调真实 IP 限流、OpenResty 回调 body 上限、告警指标名真实存在。
- **可观测性/审计**：`PayMetricsTest`（job gauge 与资金/安全指标注册）、`PayAuditLoggerTest`（链头旁路文件续链）、`LogSanitizerTest`、`HealthControllerTest`（存活探针不碰 DB）、`EnvSummaryRunnerTest`（docker profile 必填项 fail-closed）。
- **安全/性能测试（Java，src/test，不是 JS）**：
  - `PaySecurityTest`：9 个安全用例（内部 X-Internal-Key、测试入口 token、X-Uid、订单 IDOR、
    伪造回调、错误响应不泄漏堆栈）；
  - `PayPerformanceTest`：Java 并发压测，输出每端点/总体 p50/p99/p99.9，阈值、并发、时长、
    预热、请求 padding 全部可配；
  - 客户端配置 `src/test/resources/pay-test.properties`（直接改文件读取，不做环境变量/-D 注入），
    服务端线程/连接池/buffer 配置 `config-test.yaml`。
  - 命令见“独立测试环境”一节；服务未启动时安全/性能用例自动跳过。

详细设计文档：`plan/1.0.7-Pay/1.0.7-Pay.md`（本地文档，不入 git）。

## P0-P2 安全/高并发/缓存加固（2026-11）

> 详细审计结论见本轮修复记录；本节只列已落地的代码/配置项与仍需运维执行的事项。

### P0 认证边界与资金竞态

- **内部接口服务侧鉴权**：`InternalAuthFilter` + APISIX `X-Internal-Key` 注入（未配置 fail-closed 503）；
  `/internal/pay/timeout/execute` 豁免（token 单独守门）；docker profile 启动自检要求内部 key / executor token / TLS 非空。
- **退款**：自动退款/人工退款统一按数据库 `refund_prev_status` 判断是否已交付（并发交付后仍会回收会员）；
  审批表 `(order_no,status)` 唯一 + `WHERE status=PENDING` 条件更新（并发首次请求/双人复核不再竞态）。
- **重复购买第二道墙下沉到 `DeliveryService`（唯一交付入口）**：回调、重复回调自愈、DeliveryRetryJob 补偿
  全部经过同一道墙；违规订单冻结 `REFUND_HOLD` 并由调用方自动退款，无法再“既退款又保留会员”。
- **grant 幂等**：`pay_grant_idempotency(request_id)` 先占位（与会员扩展同事务），重放/网关重试命中即返回当前会员态；
  APISIX `pay_internal_grant` 使用 no-retry 上游（`upstream-app-pay-no-retry`, retries=0）。
- **日额度原子熔断**：`pay_grant_quota(day)` 行锁 + 原子累加，check-then-act 竞态消除；额度占用与会员扩展同事务回滚。
- **未支付订单上限原子化**：`pay_order.open_slot` + `(uid, open_slot)` 唯一索引，并发建单无法再用
  “先 count 再 insert”绕过 `max-open-per-user`；订单状态离开 CREATED 时槽位置 NULL。
- **订单事务隔离级别改为 READ_COMMITTED**（消除免费用户 gap lock 与旧快照导致计数不可靠）。

### P1 高并发可用性

- **健康检查拆分**：新增 `/health/live`（不碰 DB/连接池），APISIX 探活改用它；`/health` 仍真实探测 DB，
  仅作 readiness/告警。连接池饱和不再触发网关把实例整站摘除。
- **超时执行器异步化**：`/internal/pay/timeout/execute` 返回 `DeferredResult`（25s 预算），不再用 Tomcat 线程
  同步等 30s；入队增加“在途信号量（worker×4）”，超限立即 503。
- **渠道出网保护**：用户面建单/取码/读单查单统一走 32 并发信号量（2s 获取超时 → 429 CHANNEL_BUSY）；
  precreate 参数按订单缓存 5 分钟，`/pay/orders/{no}/qr` 不再每次请求都打支付宝。
- **兜底任务公平调度**：`pay_order.last_checked_at` + 索引，四个 Job 按“最久未检查”轮转，消除
  “最老 200 条反复处理、新单永远轮不到”的队头阻塞；交付补偿增加 `delivery_attempts` 上限（10 次后审计转人工）；
  `OrderTimeoutJob` 有到期单就不再空跑退避；`ReconciliationJob` 并行化到查询池。
- **回调限流修正**：APISIX `pay_callback` 改用 `http_x_forwarded_for`（边缘覆盖，真实客户端 IP）+
  50r/s/burst100；此前 key=remote_addr 在边缘转发下退化为“全站共享 10r/s”。边缘对回调路径限制 body 1MB。
- **数据库/停机**：JDBC `connectTimeout=3s/socketTimeout=15s` + MyBatis `default-statement-timeout=10s`；
  `server.shutdown=graceful` + 20s 停机等待；user 面 `/pay/*` 不再把 Bearer token 透传给 app-pay。

### P2 缓存与可观测性

- **消费侧会员缓存**（app-ts / app-cloud）：per-uid 单飞、TTL ±15% 抖动、失败结果 10s 短缓存、
  容量上限与“清过期/按比例淘汰（不整体清空）”；app-ts 增加 stale-while-revalidate。
  效果：热点 uid 过期不再并发回源（击穿）、失败不再每请求重试（穿透）、修复 60s 内按 free 档限额的可见问题。
- **指标/告警**：新增 `pay.job.last.run{job}` gauge（修复原本永不触发的 JobStalled 告警）、
  `pay_callback_amount_mismatch_total`、`pay_order_auto_refund_failed_total`、`pay_delivery_exhausted_total`、
  `pay_internal_auth_rejected_total`、`pay_channel_throttled_total`。
- **审计链**：新增 `logs/pay-audit.head` 原子链头文件，logback 按大小/日期转动后重启仍可续链；外部输入
  （回调 form / reason / operator）统一 `LogSanitizer` 清洗，防日志伪造。
- **启动自检**：docker profile 拒绝 TLS 关闭 / 内部 key 为空 / executor token 为空；默认 DB 口令改为告警
  （本地栈友好，生产替换）。

### 仍需运维执行（代码外）

- MySQL 主从/定期异地备份与恢复演练；app-admin 独立只读 DB 账号（当前仍复用 `app_pay` 账号）。
- 生产强随机 `PAY_MYSQL_PASSWORD` / `PAY_EXECUTOR_TOKEN` / `PAY_INTERNAL_KEY`（如不回落共享 key）；
  正式 CA 后收紧 APISIX upstream TLS verify 与 JDBC `verifyServerCertificate=true`。
- 容器非 root + 资源限制；审计链如需抗“有写权限的攻击者重算”，再引入 HMAC 密钥。

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
- **买家信息掩码**：`OrderView` 的 `buyerLogonId/buyerUserId` 统一掩码；DB 与 app-admin（第二连接直连库，运营查询）保留全值。
- **支付频次风控**：`pay.risk.max-paid-orders-per-day / max-paid-amount-per-day-cents`（滚动 24h，下单时拦截，
  429 `RISK_VELOCITY_EXCEEDED` + `RISK_VELOCITY_BLOCKED` 审计）。
- **CI 漏洞门禁**：`ci-app-pay.yml` 增加 Trivy 依赖扫描（HIGH/CRITICAL 红）；`.github/dependabot.yml` 每周自动升级 PR。
- **上游 TLS verify**：APISIX 3.20 已支持普通 https upstream 证书校验（3.19+，`tls.verify` + `tls.ca_certs`），但当前未给 APISIX 挂内部 CA，仍按不校验运行（见 upstream-app-pay 注释）；挂 CA 后翻 `verify:true` 并收紧 `https_verify_certificate`。
- **备份与演练**：`ops/archive/app-pay/backup/app-pay-backup.sh`（MySQL dump + 审计 JSONL，30 天轮转）+ `ops/archive/app-pay/backup/README.md` 恢复演练清单。

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
- **告警与压测**：`ops/archive/app-pay/monitoring/app-pay-alerts.rules.yml`（对账差异/回调拒绝/渠道 QPS/风控激增/Hikari 饱和）+
  `ops/archive/app-pay/loadtest/app-pay-loadtest.md` 压测基线手册（/test/pay/burst 幂等与吞吐场景）。

## 退款复核工作台（2026-10 上线；2026-11-03 并入 app-admin）

- **退款审批工作台**：统一管理台 app-admin 的「支付运营 → 退款复核」页（admin only）——待审列表直读
  `pay_refund_approval`，approve/reject 经 APISIX（pay-ops consumer，`PAY_OPS_KEY`）调 app-pay 的
  internal 端点执行；**operator = 控制台登录账号（服务端注入）**，替代 curl 自报身份；maker != checker
  由 app-pay 强制。`APPADMIN__PAY__OPS__KEY` 未配置时整组 404 隐藏；密钥只注入 app-admin-api 容器。
  原独立服务 app-pay-admin（:8003 / profile pay-admin / SSR WebUI / 自带账户）已退役，
  详见 [app-admin.md](app-admin.md)。
- **REFUND_HOLD 冻结单**：订单筛选/状态映射补齐（红色标记），冻结单经退款复核流人工处理。
- **Grant 额度对齐**：app-admin 直写 DB 原本绕过 app-pay 的日额度执行点——Grant 现在执行同一熔断
  （`pay.grant.daily_max_count=50` / `daily_max_days=1000`，按 (type,created_at) 聚合），超限 429 + 审计；
  统计查询失败 fail-open（不阻塞资金写，留 WARN）。
- **网络安全**：审计 JSONL 哈希链（chain/prev/hash，跨重启续链）对齐 app-pay（app-admin 侧落
  `logs/pay-audit.jsonl`）；管理台统一 cookie SameSite=Lax + HttpOnly（TLS 下 Secure）+ 安全响应头。
- **明确不做**：退款/关单/SKU 改价的直接 DB 写（红线不变，退款只经 internal 端点）。

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