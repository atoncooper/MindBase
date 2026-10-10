# 配置体系

> ⚠️ **Python backend（`app/`，含 `app/config/*.yaml` 分层配置）已于 2026-10-06 彻底退役**——旧的 `default.yaml → config.yaml → local.yaml` 四层合并体系随之消亡。现在是**多服务各管各的配置**，本文描述现行体系。服务清单与端口见 [architecture.md](architecture.md)。

## 总原则

1. **.env 只放密钥/敏感信息**（API key、含密码的连接串），见 [.env.example](../.env.example)；普通配置（开关/模型名/超时/并发/CORS 等）一律进各服务自己的 YAML。
2. **命名规则**：环境变量用双下划线嵌套到 YAML 字段（`MINIO__ACCESS_KEY` → `minio.access_key`），各服务有自己的前缀（`APPAUTH__`/`APPCLOUD__`/…）。
3. **优先级**（多数服务一致，以各自 config loader 为准）：YAML 默认值 < `.env`（godotenv）< 真实环境变量（compose `env_file` / `environment:` 注入）。
4. **共享 env**：一个 `.env` 驱动全部服务——各服务按需读取同名共享变量（`RDBMS__URL`/`MONGO__URI`/`REDIS__URL`/`MINIO__*`/`AI_GATEWAY__*`/`NEO4J_PASSWORD`），避免同一密钥抄多份。**例外——主加密密钥不进 .env**：独立密钥文件 `secrets/api_key_encryption_key`（gitignored，一行 base64），服务经 `SECURITY__API_KEY_ENCRYPTION_KEY_FILE` 约定读取（FILE > env，直读 env 仅应急回退；compose 挂载到 `/run/secrets/`）。

## 各服务配置入口

| 服务 | 配置入口 | env 前缀 | 敏感值占位符 |
|------|---------|---------|------|
| app-ts | `app-ts/src/config/`（`default.yaml` + loader） | 无前缀（如 `MILVUS__*`、`REDIS__URL`、`MONGO__URI`） | `AI_GATEWAY__*`、`OCR__*` |
| app-auth | `app-go/app-auth/internal/config/default.yaml`（embed 进二进制） | `APPAUTH__` | `EMAIL__*`/`SMS__*`/`WECHAT__*`/`REDIS__URL`；主密钥走 `_FILE` |
| app-cloud | `app-go/app-cloud/internal/config/default.yaml` | `APPCLOUD__` | `MINIO__*`/`AI_GATEWAY__*`/`MILVUS__*`/`MONGO__URI`/`REDIS__URL` |
| app-note | `app-go/app-note/internal/config/default.yaml` | `APPNOTE__` | `MONGO__URI`/`RDBMS__URL` |
| app-bili | `app-go/app-bili/internal/config/default.yaml` | `APPBILI__` | `AI_GATEWAY__*`/`MONGO__URI`/`REDIS__URL`；主密钥走 `_FILE` |
| app-quiz | `app-go/app-quiz/internal/config/default.yaml` | `APPQUIZ__` | `MONGO__URI`/`REDIS__URL`/`RDBMS__URL` |
| app-kg | `app-go/app-kg/internal/config/default.yaml` | `APPKG__` | `KG__URI`/`KG__PASSWORD`(=`NEO4J_PASSWORD`)/`RDBMS__URL` |
| app-settings | `app-go/app-settings/internal/config/default.yaml` | `APPSETTINGS__` | `RDBMS__URL`/`MINIO__*` |
| app-board / 三个 MCP | 各自 `default.yaml`（embed） | `APPBOARD__`/`BOARDMCP__`/`NOTEMCP__` 等 | `RDBMS__URL`/`MONGO__URI`/`REDIS__URL` |
| app-task | 独立仓库 default.yaml（embed；本仓只放密钥） | `APPTASK__` | `APPTASK__RDBMS__URL`/`APPTASK__EMAIL__API_KEY` |
| app-pay | `application.yaml` + docker/test profile 变体（Flyway 管 schema） | 经 `${VAR:默认}` 占位符 | `PAY_MYSQL_*`/`ALIPAY_*`/`PAY_TLS_*` |
| app-pay-admin | `default.yaml`（embed）+ `-config` 覆盖层 | `PAYADMIN__` | `PAYADMIN__RDBMS__URL`/`PAYADMIN__WEBUI__TOKEN` |
| frontend | 构建期 `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_APISIX_HOST`（compose 插值） | — | — |

改某个服务的配置 = 改它的 YAML 默认值（committed）或在 `.env` / compose `environment:` 覆盖（敏感值）。**新增配置项必须同步该服务自己的 default.yaml**；仅密钥类才进 `.env.example`。

## 共享基础设施连接

| 基础设施 | 消费方 | 连接来源 |
|------|------|------|
| MySQL `mind_base` | app-go 六服务 + app-board | `RDBMS__URL`（或 `APP<域>__RDBMS__URL`） |
| MySQL `app_task` / `app_pay` | app-task / app-pay | 各自专属连接串 |
| Mongo `mind_base`（Go 共享）+ `mind_base_ts`（app-ts 自有） | Go 服务 / app-ts | `MONGO__URI`（app-ts 以库区分，跨库只读 `mind_base.asr_documents`） |
| Redis | app-auth（限流/验证码）、app-quiz（quota/分享缓存）、app-ts（事件桥）、app-board（缓存 db 2） | `REDIS__URL` |
| Milvus | app-ts（`mind_base_ts`：bilibili_videos/cloud_drive/kg_entities） | app-ts config（`MILVUS__*`） |
| Neo4j | app-kg 唯一写者 | `KG__URI` + `KG__PASSWORD` |
| MinIO | app-cloud（drive-videos）、app-ts（技能 zip/壁纸）、app-board | `MINIO__*`（app-cloud 内网直连；对外预签名 URL 经 nginx `/minio-proxy/`） |

## AI 网关（Higress，`--profile ai`）

平台代发起的全部 AI 流量（LLM/embedding/rerank/ASR/OCR）统一经 Higress 出网，**供应商 key 只存在于网关**（控制台 `http://127.0.0.1:18081` 配置，持久化在 `./data/higress`，不进 `.env`/git）：

- 业务服务侧只持有 consumer key `AI_GATEWAY__API_KEY`（Higress consumer `mindbase-backend` 的 key-auth 凭证）。
- 用户不配置任何 API Key（BYOK 已于 2026-10-07 退役，app-settings 的 `/credentials` 与 `/settings/*-configs` 端点已删除）；会员档位决定模型额度。
- 模型名在网关侧原样透传；**embedding 换模型 = Milvus 对应集合全量重建**。
- 网关侧计量：usage-logger Wasm 上报 + Console Dashboard（详见 AGENTS.md §2.10）。

## 部署期密钥清单（.env 必填项）

起栈最小集：密钥文件 `secrets/api_key_encryption_key`（含主密钥，一行 base64）、`AI_GATEWAY__API_KEY`、`APISIX_CONSUMER_KEY`（服务间 key-auth）、`RDBMS__URL`/`MONGO__URI`/`REDIS__URL`/`MINIO__ACCESS_KEY`/`MINIO__SECRET_KEY`；按启用的功能补：邮件（`APPTASK_EMAIL_API_KEY`）、短信/微信（app-auth）、支付宝（app-pay）、LangSmith（可选 tracing）。逐项说明见 [.env.example](../.env.example)。
