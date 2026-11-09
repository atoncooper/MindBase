# 配置体系

> ⚠️ **Python backend（`app/`，含 `app/config/*.yaml` 分层配置）已于 2026-10-06 彻底退役**——旧的 `default.yaml → config.yaml → local.yaml` 四层合并体系随之消亡。现在是**多服务各管各的配置**，本文描述现行体系。服务清单与端口见 [architecture.md](architecture.md)。

## 总原则

1. **.env 只放密钥/敏感信息**（API key、含密码的连接串），见 [.env.example](../.env.example)；普通配置（开关/模型名/超时/并发/CORS 等）一律进各服务自己的 YAML。
2. **命名规则**：环境变量用双下划线嵌套到 YAML 字段（`MINIO__ACCESS_KEY` → `minio.access_key`），各服务有自己的前缀（app-user 沿用 `APPAUTH__`/`APPBILI__`/`APPSETTINGS__` 三套；app-content 用 `CONTENT__`，旧 `APPBOARD__`/`APPNOTE__`/`APPQUIZ__` 仅数据源兼容；其余 `APPCLOUD__`/…）。
3. **优先级**（多数服务一致，以各自 config loader 为准）：YAML 默认值 < `.env`（godotenv）< 真实环境变量（compose `env_file` / `environment:` 注入）。
4. **共享 env**：一个 `.env` 驱动全部服务——各服务按需读取同名共享变量（`RDBMS__URL`/`MONGO__URI`/`REDIS__URL`/`MINIO__*`/`AI_GATEWAY__*`/`NEO4J_PASSWORD`），避免同一密钥抄多份。**例外——主加密密钥不进 .env**：独立密钥文件 `secrets/api_key_encryption_key`（gitignored，一行 base64），服务经 `SECURITY__API_KEY_ENCRYPTION_KEY_FILE` 约定读取（FILE > env，直读 env 仅应急回退；compose 挂载到 `/run/secrets/`）。

## 各服务配置入口

| 服务 | 配置入口 | env 前缀 | 敏感值占位符 |
|------|---------|---------|------|
| app-ts | `app-ts/src/config/`（`default.yaml` + loader） | 无前缀（如 `MILVUS__*`、`REDIS__URL`、`MONGO__URI`） | `AI_GATEWAY__*`、`OCR__*` |
| app-user | `app-go/app-user/default.yaml`（服务根目录，embed 进二进制；单文件含 auth/bili/settings 三段） | `APPAUTH__`（auth）/ `APPBILI__`（bili）/ `APPSETTINGS__`（settings） | auth：`EMAIL__*`/`SMS__*`/`WECHAT__*`/`REDIS__URL`；bili：`AI_GATEWAY__*`/`MONGO__URI`/`REDIS__URL`；settings：`RDBMS__URL`/`MINIO__*`；主密钥走 `_FILE` |
| app-cloud | `app-go/app-cloud/internal/config/default.yaml` | `APPCLOUD__` | `MINIO__*`/`AI_GATEWAY__*`/`MILVUS__*`/`MONGO__URI`/`REDIS__URL`；提取码加密密钥走 `_FILE`（同 app-user 主密钥） |
| app-content | `app-go/app-content/default.yaml`（服务根目录，embed；进程级 + 唯一 database 段 + quiz 参数） | `CONTENT__`（数据源 `CONTENT__DATABASE__*`；旧 `APPBOARD__`/`APPNOTE__`/`APPQUIZ__` 兼容但须一致） | `RDBMS__URL`/`MONGO__URI`/`REDIS__URL` 仍可作为共享来源；TLS 走 `CONTENT__SERVER__TLS__*` |
| app-kg | `app-go/app-kg/default.yaml`（embed 进二进制） | `APPKG__` | `KG__URI`/`KG__PASSWORD`(=`NEO4J_PASSWORD`)/`RDBMS__URL` |
| app-content-mcp（内容域 MCP：board/note/quiz 12 工具） | 代码内默认值（少量 env，无 embed YAML） | `CONTENTMCP__`（三域共用一份） | `APISIX_CONSUMER_KEY`（经 compose 注入 `CONTENTMCP__UPSTREAM__API_KEY` / `...__SERVICE_API_KEY`） |
| app-task | 独立仓库 default.yaml（embed；本仓只放密钥） | `APPTASK__` | `APPTASK__RDBMS__URL`/`APPTASK__EMAIL__API_KEY` |
| app-pay | `application.yaml` + docker/test profile 变体（Flyway 管 schema） | 经 `${VAR:默认}` 占位符 | `PAY_MYSQL_*`/`ALIPAY_*`/`PAY_TLS_*` |
| app-admin | `app-go/app-admin/default.yaml`（embed）+ `-config` 覆盖层 | `APPADMIN__` | `APPADMIN__RDBMS__URL`；`APPADMIN__SEED__USERNAME`/`APPADMIN__SEED__PASSWORD`（种子账户）；`APPADMIN__SESSION__TTL_MINUTES`；支付运营 `APPADMIN__PAY_RDBMS__URL`/`APPADMIN__PAY__OPS__KEY`/`APPADMIN__PAY__AUDIT_FILE` |
| frontend | 构建期 `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_APISIX_HOST`（compose 插值）；运行时 `SHARE_DOMAIN`/`SHARE_PUBLIC_IP`（分享域名链，见 [sharing.md](sharing.md)） | — | — |

app-user 单进程监听三个口：8006（auth 路由）/ 8010（bili 路由）/ 8015（settings 路由），语义与原三服务一致；服务内端口可用 `APPAUTH__SERVER__PORT` / `APPBILI__SERVER__PORT` / `APPSETTINGS__SERVER__PORT` 覆盖（默认即 8006/8010/8015），compose 宿主回环映射用 `APP_USER_AUTH_PORT` / `APP_USER_BILI_PORT` / `APP_USER_SETTINGS_PORT` 覆盖。

app-content 为**单进程 / 单端口**：唯一 HTTPS listener 由根 `server`（default.yaml）配置，env 用 `CONTENT__SERVER__*`（旧 `APPBOARD__SERVER__*` 仍兼容）；compose 宿主回环映射统一 `APP_CONTENT_PORT`（默认 8004）。

根配置分区：`app/server/security/log/observability`（进程级）+ `board/note/quiz`（域级数据源与业务限制）。常用高级项：
- `server.tls.min_version`（1.2/1.3）、`client_auth`（none/request/require）、`http2`、`trusted_proxies`、`graceful_shutdown_seconds`、各阶段超时；
- `security.headers`（HSTS/Frame/Referrer/Permissions）、`security.cors`（methods/headers/expose/max-age）、`security.rate_limit`（rps/burst/key/排除路径）、`security.body_limits`（三域上限）、`security.internal_api_key`；
- `log`（level/format/output/add_source/轮转）、`observability.health.timeout_seconds`、`metrics.enabled/path`、`pprof.enabled`（默认关）。

对应 env 前缀 `CONTENT__`（双下划线嵌套，如 `CONTENT__SECURITY__RATE_LIMIT__RPS=200`）；完整默认值见 `app-go/app-content/default.yaml`。

改某个服务的配置 = 改它的 YAML 默认值（committed）或在 `.env` / compose `environment:` 覆盖（敏感值）。**新增配置项必须同步该服务自己的 default.yaml**；仅密钥类才进 `.env.example`。

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

- Coding Plan（VIP/SVIP 第三方编程套餐）：app-user 的 `app_pay.base_url`（默认 `http://apisix:9080`）与 `app_pay.key`（默认回落 `APISIX_CONSUMER_KEY`）用于会员档位校验；app-ts `quota.limits.coding_plan` 控制每日可用次数。详见 [coding-plan.md](coding-plan.md)。

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