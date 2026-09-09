# app-pay — 交易/会员服务（Spring Boot）

MindBase 会员开通：商品（SKU）→ 订单 → 支付（M1 mock / M2 微信·支付宝）→ 会员开通/续费顺延。
设计与实施计划：[plan/1.0.7-Pay/1.0.7-Pay.md](../plan/1.0.7-Pay/1.0.7-Pay.md)

## 定位与边界

- 独立服务（Java 17 + Spring Boot 3.5），模式与 `app-task/` 对齐：独立 MySQL（`app-pay-mysql`，库 `app_pay`）、APISIX 统一鉴权、**配置唯一入口 = application.yaml（+ docker/test profile 变体，敏感值经占位符引用 .env）**。
- 不 `import` 主 app；会员号即主 app `users.uid`（`X-Uid` 由 APISIX forward-auth 注入，本服务不自验登录）。
- 数据访问统一走 **MyBatis-Plus**（`mapper/`：BaseMapper 内置 CRUD；手写 SQL 一律放 `resources/mapper/*.xml`）；建表走 `schema.sql`（启动执行，幂等）。
- 金额一律 long 分；订单状态流转全走条件更新（`WHERE status=...`），回调幂等。

## 启动

> ⚠️ **服务端 HTTPS-only（含本地启动）**：`server.ssl` 强制开启（`application.yaml`），
> 交易/会员数据不允许明文上线。首次启动前先生成开发证书（gitignored，不进仓库）：

```bash
# 1) 生成开发证书（二选一；产出 app-pay/certs/{ca.crt,pay.crt,pay.key}）
bash app-pay/scripts/gen-dev-cert.sh      # Git Bash / Linux
powershell app-pay/scripts/gen-dev-cert.ps1

# 2) Docker（推荐，从项目根；容器挂载 certs → /app/certs 与 yaml 默认相对路径对齐）
docker compose --profile pay up -d --build app-pay-mysql app-pay

# 3) 本地 IDE/mvn 运行（需先起 app-pay-mysql，宿主回环端口 3307；workdir 须为 app-pay/）
mvn spring-boot:run
```

证书缺失时启动自检（`EnvSummaryRunner`）会明确报错并给出指引；应急逃生口
`PAY_TLS_ENABLED=false` 可回退明文（仅限本机排查，生产禁止）。生产挂载正式 CA
签发的证书后用 `PAY_TLS_CERT` / `PAY_TLS_KEY` 覆盖路径。

测试：`mvn test`。健康检查：`GET https://127.0.0.1:8002/health`（自签名证书用
`curl -k` 或 `--cacert app-pay/certs/ca.crt`）。

**本地运行后浏览器直接打开 `https://localhost:8002/`** —— 自动跳转到端到端测试控制台
（base yaml 即本地开发形态，无需任何配置；生产容器形态下根路径为 404，不暴露控制台）。

## API 速览

| 分组 | 端点 | 说明 |
|------|------|------|
| 用户 | `GET /pay/products` | 在售 SKU |
| 用户 | `POST /pay/orders` | 创建订单（`{skuCode, channel:"MOCK"}`） |
| 用户 | `GET /pay/orders/{orderNo}` | 订单详情（uid 归属校验） |
| 用户 | `GET /pay/membership` | 当前用户会员态 |
| 用户 | `POST /pay/mock/confirm` | **仅测试/本地形态**：模拟支付成功（`pay.mock.enabled` 守卫） |
| 回调 | `POST /pay/callback/alipay` | **M2**：支付宝异步通知（验签，应答 success/fail 文本） |
| 内部 | `GET /internal/pay/membership/{uid}` | 主 app 查会员态（非会员 `active:false`） |
| 内部 | `POST /internal/pay/grant` | 运营补偿开通（reason 必填，落审计） |

用户端点需 `X-Uid` 头（网关注入；直连调试手动携带）。完整契约与时序见计划文档 §5/§6。

## 配置

**配置唯一入口 = application.yaml**（基础=本地开发形态；`application-docker.yaml`=生产容器，`application-test.yaml`=测试/本地容器，由 compose command 激活 profile）。环境差异全部固化在各 yaml；仅敏感值经占位符引用根 `.env`：

| 占位符（.env） | 被引用位置 | 默认 |
|----------------|-----------|------|
| `PAY_MYSQL_USER` / `PAY_MYSQL_PASSWORD` | `pay.rdbms.*`（MySQL 容器与 Java 共用同名变量） | `app_pay` / `app-pay` |
| `ALIPAY_ENABLED` / `ALIPAY_APP_ID` / `ALIPAY_PRIVATE_KEY` / `ALIPAY_PUBLIC_KEY` | `pay.alipay.*` | `false` / 空（缺失启用即失败） |
| `ALIPAY_GATEWAY_URL` / `ALIPAY_NOTIFY_URL` | `pay.alipay.*` | 正式网关 / 空=查单为主 |
| `PAY_TEST_TOKEN` | test profile 测试入口令牌 | `local-test-token` |
| `APPTASK_BASE_URL` / `APISIX_CONSUMER_KEY` / `PAY_EXECUTOR_BASE_URL` | `pay.apptask.*` 超时委托 | 网关地址等 |
| `PAY_MYSQL_PORT` | compose 宿主映射 | `3307` |
| `PAY_TLS_ENABLED` / `PAY_TLS_CERT` / `PAY_TLS_KEY` | `server.ssl.*`（HTTPS-only 开关与证书路径覆盖） | `true` / `certs/pay.crt` / `certs/pay.key` |
| `PAY_EXECUTOR_CA_FILE` | compose → app-task `APPTASK__HTTP_EXECUTOR__CA_FILE`（信任 app-pay 开发 CA） | `/app/pay-certs/ca.crt` |

非敏感配置（超时分钟、job 参数、mock 开关等）一律改对应 yaml，不走环境变量。

## 调度任务

| Job | 频率 | 职责 |
|-----|------|------|
| **主路径** | 每单各自 `expires_at` | app-task 精确定时委托：下单时注册 task（payload 携带 version），到点调 `/internal/pay/timeout/execute`（executor 内 FIFO+worker 池并发自守，version 不匹配=已支付，委托作废） |
| OrderTimeoutJob | 120s 起，jitter±30%，空跑退避 cap 10min | 超时关单**兜底**（主路径失效时接管，最终一致） |
| DeliveryRetryJob | 60s 起，jitter，退避 cap 5min | `PAID` 停留 >1min → 重试交付（幂等） |
| ChannelQueryJob | 60s，jitter，不退避 | 掉单主动查单（M2 主路径） |

## 日志

- 运行日志：console + `logs/app-pay.log`（30 天轮转），行内自带 `[traceId] [uid]`
- **资金审计**：`logs/pay-audit.jsonl`（独立文件，**365 天**留存），每行一条 JSON 资金事实
  （`ORDER_PAID` / `ORDER_REOPENED` / `AMOUNT_MISMATCH` / `CALLBACK_REJECTED` 等），对账与客诉取证用
- 每请求生成/透传 `X-Trace-Id`（响应回写，可把用户反馈对到日志）；定时 job 每轮自赋 `job-*` traceId
- 红线：密钥/验签原文不入日志；Docker 挂载 `app_pay_logs` 卷持久化

## 端到端测试控制台（M3 前端就绪前的联调入口）

**测试环境（独立实例，与生产整库隔离）**：`docker compose --profile pay-test up -d app-pay-test-mysql app-pay-test`
—— 强制 MOCK 渠道、测试入口开启（令牌默认 `local-test-token`）、订单超时 2min、控制台 `https://127.0.0.1:18002/test/pay/console.html`。生产实例照常 `--profile pay` 跑 8002，两者可同时运行。

**控制台能力（v2）**：覆盖全部接口（商品/下单/沙箱二维码/模拟支付/查订单/我的最近订单/查会员/健康检查）；**请求默认验证通过**（未配置令牌时）；每请求显示 `X-Trace-Id`+状态+耗时，可复制对线日志与审计流水；**高并发模拟**走服务端 burst（闩锁同时起跑，绕过浏览器并发上限）——并发支付同一订单验证幂等（仅交付一次）、并发创建订单压测写入。

测试实例开箱即用（application-test.yaml 固化）。**生产实例不开测试入口**（docker profile 固化关闭），如需在生产临时开启只能改 application-docker.yaml 后重启：

- **浏览器控制台**：`https://127.0.0.1:8002/test/pay/console.html` —— 填令牌 → 选商品下单 → MOCK 一键支付闭环，或选 ALIPAY 出**沙箱二维码**（沙箱钱包 App 扫码，ChannelQueryJob ≤60s 自动查单确认）→ 查会员
- **一键冒烟脚本**：`PAY_TEST_TOKEN=xxx ./app-pay/scripts/smoke.sh`（下单→模拟支付→会员开通；自动信任本地 `certs/ca.crt`）
- 安全：双闸门（`pay.test.enabled` 默认 false + 令牌）+ 结构性隔离（APISIX 不路由 `/test/*`、端口仅回环）；测试动作同样进资金审计流水（`TEST_MOCK_PAY` 事件）

## TLS（HTTPS-only）

- **服务端**：Spring Boot `server.ssl` 挂 PEM 证书（`application.yaml`），三种形态（本地 base / docker / test）统一生效；启动自检打印 `tls_enabled/cert/key` 并在证书缺失时拒绝启动。
- **调用方**：APISIX `upstream-app-pay` 已改 `scheme: https`（`apisix.yaml` / `apisix.dev.yaml`，自签名阶段 `tls.verify: false` 只加密；换正式 CA 后收紧 `verify: true`）；app-task 超时委托回调（`executor_url=https://app-pay:8002/...`）经 `ca_file` 严格校验（CA 惰性加载，纯调度栈不受影响）。
- **证书**：开发/测试用 `scripts/gen-dev-cert.sh|.ps1` 自建 mini-CA + 叶子证书（SAN：localhost/127.0.0.1/::1/app-pay/app-pay-test/192.168.138.1），浏览器导入 `ca.crt` 可消除告警；生产换正式证书后同步更新各调用方信任。
