# 配置体系

> ⚠️ **Python backend（`app/`，含 `app/config/*.yaml` 分层配置）已于 2026-10-06 彻底退役**——旧的 `default.yaml → config.yaml → local.yaml` 四层合并体系随之消亡。现在是**多服务各管各的配置**，本文描述现行体系。服务清单与端口见 [architecture.md](architecture.md)。

## 总原则

1. **.env 只放密钥/敏感信息**（API key、含密码的连接串），见 [.env.example](../.env.example)；普通配置（开关/模型名/超时/并发/CORS 等）一律进各服务自己的 YAML。
2. **命名规则**：环境变量用双下划线嵌套到 YAML 字段（`MINIO__ACCESS_KEY` → `minio.access_key`），各服务有自己的前缀（app-user 沿用 `APPAUTH__`/`APPBILI__`/`APPSETTINGS__` 三套；app-content 用 `CONTENT__`，旧 `APPBOARD__`/`APPNOTE__`/`APPQUIZ__` 仅数据源兼容；其余 `APPCLOUD__`/…）。
3. **优先级**（多数服务一致，以各自 config loader 为准）：YAML 默认值 < `.env`（godotenv）< 真实环境变量（compose `env_file` / `environment:` 注入）。
   **app-ts 例外**：本地运行时由 `src/bootstrap/env.ts` 默认加载 **`app-ts/.env`**（不是项目根 `.env`；容器仍由 compose `env_file` 注入根 `.env`）。`APP_TS_ENV_FILE` 可指定其他路径，`APP_TS_ENV_DISABLED=1` 关闭；文件不覆盖已有真实环境变量，测试环境不自动加载。
4. **共享 env**：一个 `.env` 驱动全部服务——各服务按需读取同名共享变量（`RDBMS__URL`/`MONGO__URI`/`REDIS__URL`/`MINIO__*`/`AI_GATEWAY__*`/`NEO4J_PASSWORD`），避免同一密钥抄多份。**例外——主加密密钥不进 .env**：独立密钥文件 `secrets/api_key_encryption_key`（gitignored，一行 base64），服务经 `SECURITY__API_KEY_ENCRYPTION_KEY_FILE` 约定读取（FILE > env，直读 env 仅应急回退；compose 挂载到 `/run/secrets/`）。

## 2026-11-22：`.env` 收敛为"仅密钥"

`.env.example` 已重写为**纯密钥清单**；`docker-compose.yml` 中
原本用 `${VAR:-default}` 从 `.env` 取值的**非密钥项**已全部落成配置文件里的字面量：

| 类别 | 现在写在哪 | 例子（原 env 名） |
|------|-----------|------------------|
| 宿主端口 | compose `ports:` 字面量（旧 env 名不再读取） | `APP_TS_PORT` / `MYSQL_PORT` / `*_UI_PORT` / `OPEN_SANDBOX_PORT` |
| 资源上限 | compose `cpus/mem_limit` 字面量 | `APPSANDBOX_CPUS` / `OPEN_SANDBOX_MEMORY` / `APP_TS_MEM_LIMIT` |
| 镜像/构建选择 | compose `image:` / `dockerfile:` 字面量 | `OPEN_SANDBOX_IMAGE` / `OPEN_SANDBOX_SANDBOX_IMAGE` / `APP_PAY_DOCKERFILE` |
| 服务行为（开关/阈值/endpoint/路径） | compose `environment:` 字面量（服务仍按 env 读取；需要长期默认值时再进该服务 YAML） | `EMAIL__ENABLED` / `WECHAT__ENABLED` / `SANDBOX_ENABLED` / `CLOUD_ORPHAN_*` / `CLOUD_SWEEP_*` / `KG__URI` / `MINIO__ENDPOINT` / `APPADMIN__*` |
| 部署域名/分享域名 | compose 字面量（前端 build args 也在此） | `SHARE_DOMAIN` / `SHARE_PUBLIC_IP` / `NEXT_PUBLIC_API_URL` |
| DB/中间件用户名（非密钥，与密码同组管理） | compose 字面量 | `MYSQL_USER` / `APPTASK_MYSQL_USER` / `PAY_MYSQL_USER` / `MONGO_USER` |
| 服务直接读取 env 的开关（代码内 `os.Getenv`，无 YAML 键） | compose 字面量 | `MYSQL_TLS_MODE` / `LANGCHAIN_TRACING_V2` / `LANGSMITH_*`（非密钥部分） / `ALIPAY_ENABLED` / `ALIPAY_GATEWAY_URL` / `ALIPAY_NOTIFY_URL` / `EMAIL__FROM_EMAIL` |

**仍然必须留在 `.env` 的**：密码、API key、token、加密密钥、带凭据的 DSN
（`RDBMS__URL` / `MONGO__URI` / `REDIS__URL` / `MILVUS__URI` / `PAY_ADMIN_RDBMS_URL`）、
APISIX consumer/admin key、支付/短信/微信/支付宝密钥、沙箱与 MCP 令牌等，见
[`.env.example`](../.env.example)。

升级已有部署：

1. 从 `.env` 删除非密钥行（端口、开关、域名、镜像 tag、资源上限、用户名等）——
   这些值现在由配置文件兜底，删除后 `docker compose config` 结果不变；
2. 需要与默认值不同的部署，直接改对应 compose / 服务 YAML（提交进 git），
   不要在 `.env` 里重新加变量；
3. `deploy/{docker,china,swarm,k8s}` 同样只需在 `.env` 提供密钥；栈内的端口/路径/
   资源等覆盖项都写在各自 yml 的默认值里。

> 例：`APP_PAY_DOCKERFILE=Dockerfile.local`（宿主已 `mvn package` 的快速路径）不再是
> `.env` 项 —— 需要时在 `docker-compose.yml` 的 `app-pay.build.dockerfile` 里改。

## 组件配置目录：`deploy/config/`

第三方基础设施组件（etcd / Redis / MySQL / MongoDB / Milvus）的**非密钥**配置放在
[`deploy/config/`](../deploy/config/README.md)，由 compose 栈只读挂载、由 K8s 用同一份
文件生成 ConfigMap（`mysql-conf` / `mongo-conf` / `redis-conf` / `etcd-conf`）：

| 组件 | 文件 | 挂载点 |
|------|------|--------|
| etcd | `deploy/config/etcd/etcd*.conf.yml` | `/etc/etcd/etcd.conf.yml`（`--config-file`） |
| Redis | `deploy/config/redis/redis*.conf` | `/usr/local/etc/redis/redis.conf` |
| MySQL | `deploy/config/mysql/conf.d/00-base.cnf` + `10-tls.cnf` + `95-binlog.cnf` + `entrypoint-autosize.sh` | `/etc/mysql/conf.d/*.cnf`（容量由 entrypoint 生成 99-auto-sizing.cnf） |
| MongoDB | `deploy/config/mongodb/mongod.tmpl.conf` + `entrypoint-autosize.sh` | `/tmp/mongod.conf`（渲染） |
| Milvus | `deploy/config/milvus/milvus.yaml` | `/milvus/configs/milvus.yaml` |

- 文件里**不出现密码/密钥**：口令仍走 `.env`（compose env / K8s Secret）
  或命令行参数（如 `redis-server ... --requirepass $REDIS_PASSWORD`）；
- 每栈差异用带后缀的变体（`.client` / `.plain` / `.k8s`）：根 compose 用 TLS 版，
  client/Lite 用轻量版，拆分/swarm/china 用 plain 版，K8s 用 plain/k8s 版；
- Neo4j / MinIO 保留 env 或镜像默认机制（官方镜像 entrypoint 会写 `neo4j.conf`；
  MinIO 无配置文件），详见 `deploy/config/README.md` 的"例外"。

## endpoint / 连接组件与密钥边界

- **endpoint、服务名、端口、模型名、开关、超时、并发** → 写各服务 YAML（app-ts `config/default.yaml`、app-user/app-cloud 等 `default.yaml`）；
- **密钥、含密码的连接串**（API key、AccessKey、RDBMS/Mongo/Redis DSN）→ 只放 `.env` 或 Docker secret / `_FILE`；
- Docker compose 不再重复设置 `APP_*_BASE_URL`、`AI_GATEWAY__BASE_URL`、`MILVUS__ADDRESS`、`CONTENT_MCP__URL` 等 endpoint；
- 本地非 Docker 开发需要 127.0.0.1 时，用各服务支持的 `config/local.yaml`（gitignored）覆盖，不要往 `.env` 塞 endpoint。

## 各服务配置入口

| 服务 | 配置入口 | env 前缀 | 敏感值占位符 |
|------|---------|---------|------|
| app-ts | `app-ts/src/config/`（`default.yaml` + loader） | 无前缀（如 `MILVUS__*`、`REDIS__URL`、`MONGO__URI`） | `AI_GATEWAY__*`（**唯一模型凭证**；OCR/embedding/rerank 复用） |
| app-user | `app-go/app-user/default.yaml`（服务根目录，embed 进二进制；单文件含 auth/bili/settings 三段） | `APPAUTH__`（auth）/ `APPBILI__`（bili）/ `APPSETTINGS__`（settings） | auth：`EMAIL__*`/`SMS__*`/`WECHAT__*`/`REDIS__URL`；bili：`AI_GATEWAY__*`/`MONGO__URI`/`REDIS__URL`；settings：`RDBMS__URL`/`MINIO__*`；主密钥走 `_FILE` |
| app-cloud | `app-go/app-cloud/internal/config/default.yaml` | `APPCLOUD__` | `MINIO__*`/`AI_GATEWAY__*`/`MILVUS__*`/`MONGO__URI`/`REDIS__URL`；提取码加密密钥走 `_FILE`（同 app-user 主密钥） |
| app-content | `app-go/app-content/default.yaml`（服务根目录，embed；进程级 + 唯一 database 段 + quiz 参数） | `CONTENT__`（数据源 `CONTENT__DATABASE__*`；旧 `APPBOARD__`/`APPNOTE__`/`APPQUIZ__` 兼容但须一致） | `RDBMS__URL`/`MONGO__URI`/`REDIS__URL` 仍可作为共享来源；TLS 走 `CONTENT__SERVER__TLS__*` |
| app-kg | `app-go/app-kg/default.yaml`（embed 进二进制） | `APPKG__` | `KG__URI`/`KG__PASSWORD`(=`NEO4J_PASSWORD`)/`RDBMS__URL` |
| app-content-mcp（内容域 MCP：board/note/quiz 12 工具） | 代码内默认值（少量 env，无 embed YAML） | `CONTENTMCP__`（三域共用一份） | `APISIX_CONSUMER_KEY`（经 compose 注入 `CONTENTMCP__UPSTREAM__API_KEY` / `...__SERVICE_API_KEY`） |
| app-task | 独立仓库 default.yaml（embed；本仓只放密钥） | `APPTASK__` | `APPTASK__RDBMS__URL`/`APPTASK__EMAIL__API_KEY` |
| app-pay | `application.yaml` + docker/test profile 变体（Flyway 管 schema） | 经 `${VAR:默认}` 占位符 | `PAY_MYSQL_*`/`ALIPAY_*`/`PAY_TLS_*` |
| app-admin | `app-go/app-admin/default.yaml`（embed）+ `-config` 覆盖层 | `APPADMIN__` | `APPADMIN__RDBMS__URL`；`APPADMIN__SEED__USERNAME`/`APPADMIN__SEED__PASSWORD`（种子账户）；`APPADMIN__SESSION__TTL_MINUTES`；支付运营 `APPADMIN__PAY_RDBMS__URL`/`APPADMIN__PAY__OPS__KEY`/`APPADMIN__PAY__AUDIT_FILE` |
| frontend | 构建期 `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_APISIX_HOST`（compose 插值）；运行时 `SHARE_DOMAIN`/`SHARE_PUBLIC_IP`（分享域名链，见 [sharing.md](sharing.md)） | — | — |

app-user 单进程监听三个口：8006（auth 路由）/ 8010（bili 路由）/ 8015（settings 路由），语义与原三服务一致；服务内端口可用 `APPAUTH__SERVER__PORT` / `APPBILI__SERVER__PORT` / `APPSETTINGS__SERVER__PORT` 覆盖（默认即 8006），compose 宿主回环映射用 `APP_USER_AUTH_PORT` / `APP_USER_BILI_PORT` / `APP_USER_SETTINGS_PORT` 覆盖。

app-content 为**单进程 / 单端口**：唯一 HTTPS listener 由根 `server`（default.yaml）配置，env 用 `CONTENT__SERVER__*`（旧 `APPBOARD__SERVER__*` 仍兼容）；compose 宿主回环映射统一 `APP_CONTENT_PORT`（默认 8004）。

根配置分区：`app/server/security/log/observability`（进程级）+ `board/note/quiz`（域级数据源与业务限制）。常用高级项：
- `server.tls.min_version`（1.2/1.3）、`client_auth`（none/request/require）、`http2`、`trusted_proxies`、`graceful_shutdown_seconds`、各阶段超时；
- `security.headers`（HSTS/Frame/Referrer/Permissions）、`security.cors`（methods/headers/expose/max-age）、`security.rate_limit`（rps/burst/key/排除路径）、`security.body_limits`（三域上限）、`security.internal_api_key`；
- `log`（level/format/output/add_source/轮转）、`observability.health.timeout_seconds`、`metrics.enabled/path`、`pprof.enabled`（默认关）。

对应 env 前缀 `CONTENT__`（双下划线嵌套，如 `CONTENT__SECURITY__RATE_LIMIT__RPS=200`）；完整默认值见 `app-go/app-content/default.yaml`。

改某个服务的配置 = 改它的 YAML 默认值（committed）或在 `.env` / compose `environment:` 覆盖（敏感值）。**新增配置项必须同步该服务自己的 default.yaml**；仅密钥类才进 `.env.example`。

### app-user 日志硬化

`auth.log` 支持：

```yaml
log:
  level: info
  format: json
  output: stdout       # stdout|file|both
  add_source: true     # 输出 caller file:line
  redact_keys: ["password", "token", "secret", "api_key", "authorization", "cookie", "access_key"]
  sampling:
    enabled: true
    initial: 5         # 同 message 前 5 条必打
    thereafter: 100    # 之后每 100 条打一条
  async:
    enabled: true
    buffer: 4096
    drop_when_full: true
  file:
    path: /app/logs/app-user.log
    max_size: 100
    max_backups: 7
    max_age: 30
    compress: true
    compress_algorithm: "gzip"  # gzip | zstd
    compress_level: 6           # gzip 1-9 / zstd 1-19
    compress_queue: 8
    max_total_size: 2048        # MB，0=不限
```

- 活动文件保持明文（可 tail）；轮转后的归档按 `compress_algorithm` 压缩为 `.gz` 或 `.zst`；
- 压缩在独立 worker 队列执行，不阻塞请求；失败保留原文件并打印错误；
- 归档按 `max_backups` / `max_age` / `max_total_size` 清理；
- 默认脱敏 key（password/token/secret/api_key/authorization/cookie/access_key/sms_code 等）在 handler 层统一打码，业务日志不需要逐处处理；
- 采样按 level+message 去重，避免高频错误刷盘；
- async 使用有界 channel + 丢弃策略，避免日志阻塞请求；
- 轮转由 lumberjack 负责（大小/份数/天数/压缩）；
- 访问日志开关/采样/格式在 `server.access_log_*`（独立于业务日志）。

### app-user HTTP 入口硬化

`auth.server` 是单 listener（8006）的完整配置：

```yaml
server:
  host: 0.0.0.0
  port: 8006
  read_header_timeout_seconds: 5
  read_timeout_seconds: 15
  write_timeout_seconds: 30
  idle_timeout_seconds: 60
  shutdown_timeout_seconds: 10
  max_header_bytes: 1048576
  max_body_bytes: 1048576
  trusted_proxies: ["127.0.0.1", "::1", "172.16.0.0/12"]
  max_connections: 1024
  max_concurrent: 64
  max_concurrent_per_ip: 16
  http2_enabled: true
  compression: "both"          # none | gzip | br | both
  keepalive_max_requests: 1000
  access_log_enabled: true
  access_log_sample_rate: 100
  access_log_format: "slog"    # slog | text
tls:
  min_version: "1.2"
  cipher_suites: []
  client_ca_file: ""
  client_auth: "none"
```

- `max_body_bytes` 按域配置：auth/bili 1MB、settings 4MB；
- 连接/并发/每 IP 并发由 `internal/infra/httpserver` 在 engine 前统一执行；
- gzip/br 根据 `Accept-Encoding` 协商；
- keep-alive 请求数上限通过 `Connection: close` 生效；
- 访问日志支持关闭、采样率、slog/text 格式；
- TLS 支持最低版本、cipher suites、mTLS 客户端 CA/校验模式；
- `http2_enabled: false` 时强制 HTTP/1.1（TLS 下默认启用 h2）。

### app-user 连接池

app-user 的 MySQL / Redis / Mongo 池参数在 `app-go/app-user/default.yaml`：

```yaml
rdbms:
  max_open_conns: 30
  max_idle_conns: 10
  conn_max_lifetime: 1800
  conn_max_idle_time_seconds: 300
redis:
  pool_size: 50
  min_idle_conns: 5
  pool_timeout_seconds: 5
  dial_timeout_seconds: 5
  read_timeout_seconds: 3
  write_timeout_seconds: 3
  max_retries: 2
mongo:
  max_pool_size: 50
  min_pool_size: 5
  max_conn_idle_time_seconds: 300
  connect_timeout_seconds: 5
  server_selection_timeout_seconds: 5
```

auth 与 settings 共用一个 MySQL pool（`auth.rdbms`）；bili 使用独立 pool（`bili.rdbms`），避免采集/ASR 查询打满 forward-auth 热路径。auth/bili 共用同一个 Redis client 池；Mongo 池归 bili 域。

### 联网搜索（app-ts：DeepSeek / Tavily / SearXNG）

非敏感开关在 `app-ts/config/default.yaml` 的 `web` 段；**只有 API key 进 `.env`**：

```yaml
web:
  deepseekApiKey: ${DEEPSEEK_API_KEY:}   # 为空 = DeepSeek 引擎禁用
  deepseekApiBaseUrl: https://api.deepseek.com
  deepseekFetchPrimary: true
  searchTavilyApiKey: ${TAVILY_API_KEY:}
  searchSearxngUrl: ${SEARXNG_URL:}
```

- `DEEPSEEK_API_KEY`：DeepSeek 官方网页搜索/抓取（`web_search` 首选引擎；`fetch_webpage` 官方代抓优先，失败回退本地抓取）；**这是联网工具 key，不是模型凭证**——所有模型统一用 `AI_GATEWAY__API_KEY`；
- 未配置 DeepSeek 时依次回退 Tavily → SearXNG → 百度/Bing 抓取；
- 只配 key 即可，不要把 key 写进 YAML；`.env.example` 已给出占位说明。

### 短信验证码（app-user，阿里云双产品）

**非敏感配置全部在 `app-go/app-user/default.yaml` 的 `sms` 段（YAML 是唯一事实来源），`.env` 只放 AccessKey 密钥对。** 不再支持用 `SMS__PROVIDER` 等 env 覆盖这些字段。

```yaml
sms:
  enabled: true
  provider: dypnsapi        # dysmsapi | dypnsapi
  sign_name: "赠送签名"
  template_code: "100001"
  template_codes:           # 按业务 purpose 选模板；未匹配回退 template_code
    login: "100001"
    bind_phone: "100004"
    twofa_sms: "100005"
  scheme_name: ""           # dypnsapi 方案名；发送/核验必须一致，空=默认方案
  country_code: "86"        # dypnsapi 当前仅支持中国大陆
  code_source: aliyun       # local=本服务生成+本地核验；aliyun=阿里云生成+核验
  interval_seconds: 60
  duplicate_policy: 1
  auto_retry: 1
  template_params: {}       # 仅模板额外变量（如 {min: "5"}），不是模板列表
```

| provider | 产品 | 适用 | 验证码归属 |
|---|---|---|---|
| `dysmsapi`（默认） | 短信服务 | 自定义签名+模板 | 本服务生成，存 `verification_codes`，本地常量时间比对 |
| `dypnsapi` | 号码认证服务-短信认证 | 个人开发者可用控制台**赠送签名/模板** | `code_source: local` 同左；`aliyun` 时由阿里云生成并通过 `CheckSmsVerifyCode` 核验（核验免费，明文码不落库） |

- `.env` 仅需：`SMS__ACCESS_KEY_ID` / `SMS__ACCESS_KEY_SECRET`（RAM 最小权限：`dysms:SendSms` 或 `dypns:SendSmsVerifyCode` / `dypns:CheckSmsVerifyCode`）。
- dypnsapi **只支持控制台赠送的签名/模板**（该产品不支持自定义签名）：`sign_name` 从「赠送签名配置」页选，`template_code`/`template_codes` 从「赠送模板配置」页选且必须与签名配套。
- 模板必须含 `${code}`；`code_source: aliyun` 会发送 `TemplateParam={"code":"##code##"}`，其余场景发送真实 code。
- 发送入口 `POST /auth/phone/send-code`，前端按 `/auth/features` 的 `sms_enabled` 显隐；日志只记脱敏手机号，不记验证码。
- SMS 配置齐全时，绑定手机必须走 `POST /auth/phone/verify`（验证码）；`PUT /auth/phone`（未验证直接绑定）会被服务端 403 拒绝，避免绕过验证。
- 解绑手机号（`DELETE /auth/phone`）也必须验证：要么带 `code`（先 `POST /auth/phone/send-code`，`purpose=unbind`，验证码只发到当前已绑定手机），要么带 `current_password`（已设密码的账号）；两者都没有返回 403。

- Coding Plan（VIP/SVIP 第三方编程套餐）：app-user 的 `app_pay.base_url`（默认 `http://apisix:9080`）与 `app_pay.key`（默认回落 `APISIX_CONSUMER_KEY`）用于会员档位校验；app-ts `quota.limits.coding_plan` 控制每日轮次上限（自带套餐不占平台 token 额度；AI 用量额度见下节）。详见 [coding-plan.md](coding-plan.md)。

### AI 用量额度（app-ts `quota`）

2026-11-22 起，AI 额度从「每日次数」改为 **标准 token + 三层窗口**（滚动 5 小时 / 自然日 / 自然月），所有 AI 能力共享一个池；聊天按真实 usage，出题/批改/KG/向量化/OCR/Board/科研按一次操作的估算 token 扣。普通配置在 `app-ts/config/default.yaml` 的 `quota:` 段，密钥仍只在 `.env`：

```yaml
quota:
  enabled: true
  referencePricePerMTok: 10   # 标准 token 参考价（元/百万）
  planBonus: 10               # 订阅价值倍率：¥48 → ¥480 等值
  fiveHourMinutes: 300
  bucketMinutes: 5
  plans:
    free: { priceYuan: 0,  monthlyTokens: 300000,   dailyTokens: 30000,   fiveHourTokens: 6000 }
    vip:  { priceYuan: 18, monthlyTokens: 18000000, dailyTokens: 600000,  fiveHourTokens: 120000 }
    svip: { priceYuan: 48, monthlyTokens: 48000000, dailyTokens: 1600000, fiveHourTokens: 320000 }
  prices:
    "z-ai/glm-5.3-flash": { input: 0.188, output: 6.48 }
  modelWeights: {}            # 可选：覆盖额度权重（只影响额度，不影响成本账本）
  kindTokenCost:              # 非聊天操作一次扣多少标准 token
    generate: 8000
    grade: 3000
  limits:                     # 仅两类非用量按次口径
    coding_plan: { free: 0, vip: 100, svip: 300 }
    task_quiz_active: { free: 2, vip: 10, svip: 30 }
```

- **模型抵扣**：默认权重 = 模型单价 / `referencePricePerMTok`；贵模型扣得更快，便宜模型更耐跑。`prices` 必须按网关实际结算价校准。
- **10× 权益**：`planBonus=10` 时 ¥48 VIP = ¥480 等值 = 4800 万标准 token；SVIP ¥148 = ¥1,480、ProMax ¥248 = ¥2,480。这里的数字是人民币等值，不是 token 万数。
- **只保留两个按次例外**：Coding Plan（用户自带第三方套餐，不占平台 token）与 `task_quiz_active`（活跃定时任务存量）。
- **失败方向**：Redis 不可用 fail-open 放行；app-pay 不可用 fail-closed 回落 free；失败/重试轮次不扣。
- 完整设计、API 契约、键空间、调参顺序与迁移见 [ai-quota.md](ai-quota.md)。

## 共享基础设施连接

| 基础设施 | 消费方 | 连接来源 |
|------|------|------|
| MySQL `mind_base` | app-go 五服务 | `RDBMS__URL`（或 `APP<域>__RDBMS__URL`） |
| MySQL `app_task` / `app_pay` | app-task / app-pay；app-admin 经第二连接只读 `app_pay`（+ 补偿开通） | 各自专属连接串（app-admin：`APPADMIN__PAY_RDBMS__URL`） |
| Mongo `mind_base`（Go 共享）+ `mind_base_ts`（app-ts 自有） | Go 服务 / app-ts | `MONGO__URI`（app-ts 以库区分，跨库只读 `mind_base.asr_documents`） |
| Redis | app-user（auth 限流/验证码）、app-content（quiz quota/分享缓存；board 缓存 db 2）、app-ts（事件桥） | `REDIS__URL` |
| Milvus | app-ts（`mind_base_ts`：bilibili_videos/cloud_drive/kg_entities） | app-ts config（`MILVUS__*`） |
| Neo4j | app-kg 唯一写者 | `KG__URI` + `KG__PASSWORD` |
| MinIO | app-cloud（drive-videos）、app-ts（技能 zip/壁纸） | `MINIO__*`（app-cloud 内网直连；对外预签名 URL 经 nginx `/minio-proxy/`） |

## AI 网关（Higress，`--profile ai`）

平台代发起的全部 AI 流量（LLM/embedding/rerank/ASR/OCR）统一经 Higress 出网，**供应商 key 只存在于网关**（控制台 `http://127.0.0.1:18081` 配置，持久化在 `./data/higress`，不进 `.env`/git）：

- 业务服务侧只持有 consumer key `AI_GATEWAY__API_KEY`（Higress consumer `mindbase-backend` 的 key-auth 凭证）。
- 用户不配置任何 API Key（BYOK 已于 2026-10-07 退役，app-user（settings 路由）的 `/credentials` 与 `/settings/*-configs` 端点已删除）；会员档位决定模型额度。
- 模型名在网关侧原样透传；**embedding 换模型 = Milvus 对应集合全量重建**。
- 网关侧计量：usage-logger Wasm 上报 + Console Dashboard（详见 AGENTS.md §2.10）。

## 部署期密钥清单（.env 必填项）

起栈最小集：密钥文件 `secrets/api_key_encryption_key`（含主密钥，一行 base64）、`AI_GATEWAY__API_KEY`、`APISIX_CONSUMER_KEY`（服务间 key-auth）、`RDBMS__URL`/`MONGO__URI`/`REDIS__URL`/`MINIO__ACCESS_KEY`/`MINIO__SECRET_KEY`；按启用的功能补：邮件（`APPTASK_EMAIL_API_KEY`）、短信/微信（app-user auth 路由）、支付宝（app-pay）、LangSmith（可选 tracing）。逐项说明见 [.env.example](../.env.example)。