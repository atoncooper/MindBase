# app-content-mcp — 内容域 MCP server（思维导图/白板 + 笔记 + 测验）

> 2026-11-08（plan/1.0.20）：原三个 MCP server `app-board-mcp`（8005）+ `app-note-mcp`（8009）+ `app-quiz-mcp`（8012）
> 合并为**一个** Go 服务 `app-go/app-content-mcp`（单 Go module / 单镜像 / 单容器 / 单端口 **8019** / 单 `/mcp` 端点）。
> **工具面与协议零改动**：12 个工具（board 6 + note 4 + quiz 2）名称/参数/返回文案不变，board 的 3 个 resources 与 3 个 prompts 一并保留；
> app-ts 的 prompt 契约、前端、SSE 协议、APISIX 路由全部零改动。上游仍经 APISIX key-auth 三条 internal 路由到 app-content（8004）。

## 一、定位与合并动机

| 维度 | 说明 |
|------|------|
| 角色 | app-content（内容域三面）的 MCP 适配层：**12 个工具**（board 6 / note 4 / quiz 2）+ 1 个资源模板（动态列表）+ 3 个 prompts，薄映射、无业务逻辑 |
| 技术栈 | Go 1.25 + [mcp-go](https://github.com/mark3labs/mcp-go) v1.1.0 + 官方 uuid/godotenv |
| 传输 | `--transport stdio`（本地 MCP 宿主直拉）或 `--transport http`（streamable-http，容器部署；MCP 端点 `/mcp`，另有 `GET /health`） |
| 端口 | 容器 **8019**；宿主 `127.0.0.1:${APP_CONTENT_MCP_PORT:-8019}:8019`（`/health` 免认证） |
| 身份 | 双模式：①外部宿主 = Bearer token + 固定 uid；②服务模式 = app-ts 以 `apikey` + 每请求 `X-Uid` 访问。**uid 永不出现在 LLM 可写参数里** |
| 上游 | app-content（Go + Gin，内容域三面：`/internal/board/*`、`/internal/note/*`、`/internal/quiz/*`，单端口 8004 HTTPS，仅 compose 网络内可达） |
| 工具面 | board 6：`list_boards` / `get_board` / `create_board` / `update_board` / `delete_board` / `pin_board`；note 4：`save_note` / `list_notes` / `get_note` / `update_note`；quiz 2：`save_quiz` / `save_grading` |

**合并动机**：三个 MCP server 是同一域（app-content）的三个薄适配层，同构实现了 identity/logger/serve/TLS/限流/鉴权，
只是工具面不同——拆成三个 module/镜像/容器/端口/日志卷的运维成本与网络面都高于收益。合并后**工具契约、鉴权语义、网关路由、
上游 internal 契约全部不变**，改动只在部署形态与工程结构：一个进程、一个 `/mcp` 端点、一个日志卷、一个 `CONTENTMCP__` env 前缀。

**合并原则**：**按 MCP 原语组织**——`internal/mcp/tools`（12 工具）、`internal/mcp/resources`（board 模板 + 动态 list）、`internal/mcp/prompts`（3 prompts）、`internal/mcp/kit`（原语无关的 wrap/结果/未配置守卫）；上游按域 `internal/upstream/{board,note,quiz}` 隔离，各模块互不 import；唯一组合根是 `main.go`（经 `internal/bootstrap` 装配）；不制造 god package。

**不做**：不把 MCP 挂进 app-content 进程（不是 in-process MCP）；不改 app-content 业务代码。

## 二、拓扑与链路

```
外部 MCP 宿主（ZCode / Claude …）      app-ts（note/quiz 手写 wrapper + board 5 工具动态桥接；delete_board 不桥接给 AI）
        │ streamable-http + Bearer                 │ streamable-http + apikey + X-Uid
        └───────────────────┬───────────────────────┘
                            ▼
              app-content-mcp 容器 :8019 /mcp（单端点，12 工具）
        每次上游调用：http://apisix:9080/internal/{board,note,quiz}/*
        头：apikey(=APISIX_CONSUMER_KEY) + X-Uid + X-Request-Id
                            │
                            ▼
        APISIX key-auth 路由 board_internal / note_internal / quiz_internal
        （key-auth + limit-req 20rps/burst10 + proxy-rewrite 注入 X-Internal-Key）
                            │ https
                            ▼
        app-content:8004 /internal/{board,note,quiz}/*（InternalAuth 校验 X-Internal-Key + X-Uid 属主过滤）
```

- 三个域的上游对 MCP server 只是不同 base path，**共用同一个 APISIX consumer key**（`APISIX_CONSUMER_KEY`）。
- APISIX 三条 internal 路由与 consumer **零改动**（只同步注释里的服务名）；MCP server 不直连 app-content。
- `/internal/*` 不暴露到 nginx，只在 compose 网络内可达。

## 三、身份模型与端点防护

**双模式鉴权（安全边界）**

| 模式 | 凭证 | 身份来源 | 典型调用方 |
|------|------|---------|-----------|
| 外部宿主（Bearer） | `Authorization: Bearer <CONTENT_MCP_AUTH_TOKEN>`（常量时间比较，缺失/错误 401） | 配置固定 uid `CONTENTMCP__UPSTREAM__UID` | ZCode / Claude 等 MCP 宿主 |
| 服务模式（apikey） | `apikey: <APISIX_CONSUMER_KEY>`（= `CONTENTMCP__SERVER__SERVICE_API_KEY`） | 每请求 `X-Uid: <uid>`（来自 app-ts 已认证会话） | app-ts 后端（note/quiz/board agent） |

**uid 红线**：两种模式的身份都来自请求头或配置，**工具参数里永远没有 uid**——Agent 无论被怎样提示，都只能操作服务端认定的那个用户的数据。
这与 app-task「uid 放请求体、调用方可信」的 M2M 惯例一致，key-auth 持有者即受信内部服务。

**Bearer 工具白名单（合并后的最小权限）**：3→1 合并后一个外部 token 原本能触达全部 12 个工具，可用
`CONTENTMCP__SERVER__BEARER_ALLOWED_TOOLS`（逗号分隔）把它钉在子集上；空 = 不限制（兼容旧行为）。
该限制**只作用于 Bearer 模式**：`tools/list` 同步只返回白名单内的工具，越权 `tools/call` 返回 tool error。app-ts 的服务模式（apikey + 每请求 X-Uid）始终保有全部工具。

**`/mcp` 端点防护链（http 传输，按请求顺序）**

| 层 | 默认 | 说明 |
|----|------|------|
| 限流 | 10 rps / burst 20 | 全局 token bucket（鉴权前），超限 429；鉴权后再加 per-uid 桶（`..._RATE_LIMIT_PER_UID_RPS/_BURST`，0=关闭） |
| 认证 | **双模式凭证必居其一** | Bearer token **或** 服务模式 apikey；缺失/错误 401。**http 传输两者皆缺=拒启（fail-closed）**；stdio 传输不需要（进程级信任） |
| Origin 校验 | 拒绝所有 | 浏览器必带 Origin 而 MCP 宿主不带——非白名单 Origin 一律 403（MCP 规范的 DNS rebinding 防御）。Web 版 MCP 客户端出现时用 `CONTENTMCP__SERVER__ALLOWED_ORIGINS` 开白名单 |
| 并发上限 | 8 | 超限 503 + Retry-After（`CONTENTMCP__SERVER__MAX_INFLIGHT`） |
| body 上限 | 10MB | 超限 413（`CONTENTMCP__SERVER__MAX_BODY_BYTES`；board 文档上限 8MB + envelope 余量） |
| 工具面限制 | 全部 12 个 | 仅 Bearer 模式可被 `CONTENTMCP__SERVER__BEARER_ALLOWED_TOOLS` 收窄（服务模式不受限） |
| 参数 schema 校验 | 开启 | mcp-go `WithInputSchemaValidation`：类型/必填不符时以 tool error 返回（模型可自纠），不进入 handler |
| 审计 | 每次工具调用一行 | `tool` + `auth_mode`（service/bearer/stdio）+ `uid` + elapsed + 安全参数（不含正文/标题文本） |

**上游防护**：APISIX 三条 internal 路由均带 `limit-req`（每调用方 20 rps + burst 10，429）兜底，防止任何 key-auth 持有者打爆 app-content；
board 的 search 在工具层最多放大 10 次上游调用，两层相乘有界。

## 四、工具面（12 个工具）

### 4.1 board（6，上游 `/internal/board/*`）

| 工具 | 参数 | 说明 |
|------|------|------|
| `list_boards` | `kind?`、`page?`、`page_size?`、`search?` | 元数据列表；`search` 为标题子串过滤（忽略大小写，跨页扫描上限 1000 条后置 `truncated:true`） |
| `get_board` | `board_uuid` | 元数据 + 正文（content 解析为 JSON 对象返回），带乐观锁 `version` |
| `create_board` | `title`、`kind?`、`content?` | kind 默认 `mindmap`；content 可传对象或 JSON 字符串，原样存储 |
| `update_board` | `board_uuid`、`expected_version?`、`title?`、`content?`、`is_pinned?` | 至少一个字段；`expected_version` 省略时自动锁定最新版本（末写者胜，输出注明）；409 冲突时返回最新版本号 |
| `delete_board` | `board_uuid` | 软删除（服务端 Mongo 正文保留备人工恢复） |
| `pin_board` | `board_uuid`、`is_pinned` | 走 PATCH，不递增 version |

### 4.2 note（4，上游 `/internal/note/*`）

| 工具 | 参数 | 说明 |
|------|------|------|
| `save_note` | `title`、`target_type`（video \| cloud_file）、`target_id`、`content_md` | 保存一篇 Markdown 笔记；`video` 用 `bvid:cid`，`cloud_file` 用文档 id；内容 ≤256KB，服务端二次消毒 |
| `list_notes` | `target_type?` | 仅元数据（标题/uuid/目标/更新时间），不含正文 |
| `get_note` | `note_uuid` | 返回完整 Markdown 正文 + 元数据 |
| `update_note` | `note_uuid`、`content_md`、`title?` | `content_md` 是**完整替换**而非追加 |

### 4.3 quiz（2，上游 `/internal/quiz/*`）

| 工具 | 参数 | 说明 |
|------|------|------|
| `save_quiz` | `topic`、`questions[]`（question/options/answer/explanation） | 提交生成的整套题目（3-8 题），持久化到用户测验历史 |
| `save_grading` | `quiz_id?`、`score`（0-100）、`total`、`per_question[]`（index/verdict/feedback） | 提交批改结果，进入用户测验历史 |

**内容格式**（工具描述内嵌同样说明）：
- mindmap = simple-mind-map 树：`{"root":{"data":{"text":"中心主题"},"children":[{"data":{"text":"分支"},"children":[]}}]}`
- whiteboard = Excalidraw scene JSON（app-content board 面存储契约已就绪，编辑器 P3 接入）
- 单板正文上限 8MB（超限 413，错误消息已注明）；笔记正文 ≤256KB（服务端校验）

### 4.4 Resources（board）

`board://{uuid}` 资源模板：宿主可直接 `resources/read` 读取一块板子的完整文档（宿主控制的上下文，与工具互补——发现走 resources/list 或 list_boards，读取走资源）。

- **内容**：包装 JSON（mimeType `application/json`）`{uuid,title,kind,version,isPinned,createdAt,updatedAt,content:<解析后的文档对象>}`——version 随载荷给出，可直接用于 update_board 乐观锁
- **动态列表**：`resources/list` 经 `OnAfterListResources` 钩子在**请求时**分页拉取上游（上限 1000 条，截断时末条 description 标注"更多请用 list_boards"）——零轮询、零陈旧快照；每次 list 最多 10 次上游调用，受端点限流约束
- **能力**：`subscribe=false`（app-content board 面无变更推送源）、`listChanged=false`（注册集不变，列表靠请求时刷新）——均属红线
- 大文档（上限 8MB）整份进入宿主上下文，宿主/用户自行斟酌

### 4.5 Prompts（board）

3 个引导式任务模板（宿主侧表现为斜杠命令；渲染为单条 user 消息，纯模板不调上游，工具调用由 LLM 执行）：

| 名称 | 参数 | 行为 |
|---|---|---|
| `organize_into_board` | `text`（必填）、`title?`、`kind?` | 引导 LLM 把文本层级化后调 `create_board` 建板，报告 uuid/标题/一级分支 |
| `review_board` | `board_uuid`（必填） | 先 `get_board`，按 5 维体检（深度失衡/同级重复/缺失叶子/节点过载/层级过深），输出问题清单+改进文档 JSON；**明确先给方案、用户确认后才调 update_board** |
| `board_to_outline` | `board_uuid`（必填）、`depth?` | 先 `get_board`，按 # 层级输出 markdown 大纲 |

## 五、上游三条 internal 路由

| MCP 域 | 上游路径（经 APISIX） | APISIX 路由 id | app-content upstream | app-content 端点 |
|--------|----------------------|----------------|----------------------|------------------|
| board | `/internal/board/*` | `board_internal`（priority 100） | `upstream-app-content-board` | `/internal/board/*`（InternalAuth + RequireUID） |
| note | `/internal/note/*` | `note_internal`（priority 100） | `upstream-app-content-note` | `/internal/note/*` |
| quiz | `/internal/quiz/*` | `quiz_internal`（priority 100） | `upstream-app-content-quiz` | `/internal/quiz/*` |

- 三条路由都是 `key-auth`（consumer `internal`，= `APISIX_CONSUMER_KEY`）+ `limit-req` 20rps/burst10 + `proxy-rewrite` 注入 `X-Internal-Key`
  （app-content 的 `/internal/*` 二次令牌校验，fail-closed；与路由 key-auth 构成纵深防御）。
- 三个 upstream 节点都是 `app-content:8004`（scheme https，`tls.verify: false`；健康检查 HTTPS 不验证书）。
- 每次上游调用生成 `X-Request-Id`，错误消息透传服务端 `detail` + `request_id`；日志四段贯穿：access log → 工具调用日志 → 上游 X-Request-Id → app-content 日志。

## 六、配置（env 前缀 `CONTENTMCP__`）

env 双下划线嵌套；godotenv 自工作目录向上找项目根 `.env`（进程 env 优先）。

| 键 | 默认 | 说明 |
|---|---|---|
| `CONTENTMCP__UPSTREAM__BASE_URL` | `http://127.0.0.1:9080` | APISIX 网关 base（compose 内 `http://apisix:9080`；三个域共用） |
| `CONTENTMCP__UPSTREAM__API_KEY` | 空 | APISIX key-auth consumer key（三域共用；就是 `APISIX_CONSUMER_KEY`，密钥走 .env） |
| `CONTENTMCP__UPSTREAM__UID` | 0 | Bearer 模式固定 uid（服务模式按请求 `X-Uid`）；**空=未配置，容器照常启动但 Bearer 模式工具调用报错** |
| `CONTENTMCP__SERVER__TRANSPORT` | `stdio` | `stdio` \| `http` |
| `CONTENTMCP__SERVER__HTTP_ADDR` | `:8019` | http 传输监听地址 |
| `CONTENTMCP__SERVER__AUTH_TOKEN` | 空 | 外部 MCP 宿主 Bearer token（= `.env` 的 `CONTENT_MCP_AUTH_TOKEN`） |
| `CONTENTMCP__SERVER__SERVICE_API_KEY` | 空 | 服务模式 apikey（= `APISIX_CONSUMER_KEY`） |
| `CONTENTMCP__SERVER__ALLOWED_ORIGINS` | 空 | Origin 白名单（逗号分隔；空=拒绝所有带 Origin 的请求） |
| `CONTENTMCP__SERVER__RATE_LIMIT_RPS` / `..._BURST` | 10 / 20 | 进程级 `/mcp` 令牌桶（鉴权之前） |
| `CONTENTMCP__SERVER__RATE_LIMIT_PER_UID_RPS` / `..._BURST` | 10 / 20 | 按身份令牌桶（鉴权之后；key=acting uid，Bearer 用配置固定 uid；`0` = 关闭） |
| `CONTENTMCP__SERVER__MAX_BODY_BYTES` | 10MB | board 文档上限 8MB + envelope |
| `CONTENTMCP__SERVER__MAX_INFLIGHT` | 8 | 并发上限（超出 503） |
| `CONTENTMCP__SERVER__BEARER_ALLOWED_TOOLS` | 空 | 外部 Bearer 宿主的工具白名单（逗号分隔；空=全部 12 个；服务模式不受限） |
| `CONTENTMCP__SERVER__TLS__ENABLED` | false | 跨机宿主时开（默认关=回环 http） |
| `CONTENTMCP__SERVER__TLS__CERT_DIR` | `/app/certs` | 自动模式证书目录（dev-ca + 叶子持久化） |
| `CONTENTMCP__SERVER__TLS__CERT_FILE` / `__KEY_FILE` | 空 | 显式证书模式（compose 传 `/app/certs/server.crt|key`）；成对提供则加载；只给一个=启动报错 |
| `CONTENTMCP__LOG__LEVEL` / `__FORMAT` / `__OUTPUT` | info / json / stderr | `OUTPUT`：stderr \| stdout \| file \| both（both=stdout+file） |
| `CONTENTMCP__LOG__FILE` | `/app/logs/app-content-mcp.log` | 文件路径（Output 含 file 时生效，lumberjack 轮转） |
| `CONTENTMCP__LOG__FILE_MAX_SIZE` / `_MAX_BACKUPS` / `_MAX_AGE` / `_COMPRESS` | 100 / 7 / 30 / false | 轮转参数 |

`.env` 侧（compose 插值名，非服务直接读取）：`CONTENT_MCP_UID`、`CONTENT_MCP_AUTH_TOKEN`、`CONTENT_MCP_TLS_ENABLED`、`CONTENT_MCP_BEARER_ALLOWED_TOOLS`（可选）、
`APP_CONTENT_MCP_PORT`（宿主调试口）。**http 模式 fail-closed**：`AUTH_TOKEN` 与 `SERVICE_API_KEY` 双缺则拒绝启动。

命令行 `--transport` / `--http-addr` 可覆盖同名 env（容器 ENTRYPOINT 已固定为 http）。

## 七、TLS

默认**关**（回环 http 是本机部署的既定姿态，token + Origin + 限流已覆盖本地威胁面）；跨机 MCP 宿主、放宽回环绑定、
或宿主强制 https 时启用。实现移植自 app-content 的 TLS rotator（MCP 侧 `internal/certs`），策略一致：

| 模式 | 触发条件 | 行为 |
|------|---------|------|
| 自动（本地/可写目录） | ENABLED=true 且 CERT_FILE/KEY_FILE 双空 | 首次启动生成持久 dev-CA（10 年）+ 叶子（ECDSA P-256 / 825 天，SAN 含 localhost/127.0.0.1/::1/容器名），每日巡检：<30 天自动重签、文件丢失自愈、热切换不重启。**compose 形态走显式模式**（cert-gen 签发叶子到 bind mount，root 属主目录下 auto 模式会因无写权限失败） |
| 显式 | CERT_FILE/KEY_FILE 成对提供 | 直接加载（生产 CA 签发证书）；只给一个=拒启；临近过期仅告警（续期外部负责） |

启用步骤（compose）：

```bash
# 1. .env 置 CONTENT_MCP_TLS_ENABLED=true 后
docker compose up -d --force-recreate app-content-mcp
# 2. CA 自动生成在 ./app-go/app-content-mcp/certs/dev-ca.crt（cert-gen 统一签发）
# 3. MCP 宿主侧信任 CA：
#    - Node 系宿主（默认不读系统证书库）：环境变量 NODE_EXTRA_CA_CERTS=<dev-ca.crt 绝对路径>
#    - 系统库宿主：把 dev-ca.crt 装入系统"受信任的根证书颁发机构"
# 4. 宿主 URL 改为 https://127.0.0.1:8019/mcp（Authorization 头不变）
```

握手基线 TLS 1.2+；证书协商走 `tls.Config.GetCertificate`（轮换热生效，无需重启）；显式证书成对提供。stdio 传输无网络，TLS 不适用。

> **Windows 宿主注意**：走 schannel 的客户端（Windows 自带 curl、PowerShell Invoke-WebRequest 等）会对无 CRL 的自签链报
> `CERT_TRUST_REVOCATION_STATUS_UNKNOWN`——证书本身有效，需 `curl --ssl-no-revoke` 或客户端关闭吊销检查；
> Node 系宿主（用 NODE_EXTRA_CA_CERTS）与 OpenSSL 系不受影响。已实测：CA 严格校验（非 -k）下 health 200、initialize 200、无 token 401。

## 八、日志与可观测性

结构化 slog（JSON 或 text），消息带 `[CONTENTMCP]` 前缀，与 app-content 的全局 logger 同一套约定（`app-go/app-content/internal/logger`）：

| 维度 | 说明 |
|------|------|
| 传输约束 | **stdio 模式默认/强制 stderr**（stdout 是 MCP JSON-RPC 协议通道）；误配 `OUTPUT=stdout/both` 时启动期告警并自动回落 stderr |
| 请求级 trace | X-Request-Id：http 模式由中间件注入（认入站头，回显响应头，截断 64 字符）；stdio 模式每次工具调用生成；同一 id 贯穿 **access log → 工具调用日志 → 上游 X-Request-Id → app-content 日志**，一次 Agent 动作一条 trace |
| access log | http 模式每请求一行（method/path/status/size/latency/request_id），status≥500 error、≥400 warn、否则 info |
| 工具调用日志 | 每次调用一行：tool、board_uuid/kind/分页/置顶等安全参数、`title_len`/`content_bytes`（**只记长度不记内容**——文档正文、笔记正文、题目/答案/批改文本与标题文本均不落日志）、elapsed；成功 info、业务失败 warn、handler 异常 error |
| 上游调用日志 | 每次网关调用一行：4xx warn（Agent 可自纠）、5xx/网络错误 error、成功 debug（level=info 时静默） |
| panic | 工具 handler panic 记 error + 堆栈，转为工具错误结果返回（不炸 MCP 会话） |
| 排查 | compose 卷 `app_content_mcp_logs` → `/app/logs/app-content-mcp.log`；docker logs 看 stdout 同样内容 |

## 九、部署

| 项 | 值 |
|---|---|
| 目录 | `app-go/app-content-mcp/` |
| Go module | `app-content-mcp`（go 1.25.5） |
| 镜像 | `atoncooper/mind-base-app-content-mcp:latest` |
| 容器 | `mind-base-app-content-mcp` |
| 端口 | 容器 **8019**；宿主 `127.0.0.1:${APP_CONTENT_MCP_PORT:-8019}:8019` |
| MCP 端点 | `/mcp`（streamable-http，默认） |
| 健康 | `/health`（免认证，200） |
| 日志 | `/app/logs/app-content-mcp.log`（卷 `app_content_mcp_logs`） |
| 证书目录 | `./app-go/app-content-mcp/certs` → 容器 `/app/certs`（cert-gen 签发，TLS 默认关） |
| compose profile | `["", "content-mcp", "full"]`（默认栈启动——board/note/quiz agent 是主栈功能） |

```yaml
app-content-mcp:
  image: atoncooper/mind-base-app-content-mcp:latest
  pull_policy: never
  build: { context: ./app-go/app-content-mcp, dockerfile: Dockerfile }
  container_name: mind-base-app-content-mcp
  profiles: ["", "content-mcp", "full"]
  depends_on: { cert-gen: { condition: service_completed_successfully } }
  environment:
    - CONTENTMCP__UPSTREAM__BASE_URL=http://apisix:9080
    - CONTENTMCP__UPSTREAM__API_KEY=${APISIX_CONSUMER_KEY:?err_APISIX_CONSUMER_KEY_not_set_in_.env}
    - CONTENTMCP__UPSTREAM__UID=${CONTENT_MCP_UID:-}
    - CONTENTMCP__SERVER__AUTH_TOKEN=${CONTENT_MCP_AUTH_TOKEN:-}
    - CONTENTMCP__SERVER__SERVICE_API_KEY=${APISIX_CONSUMER_KEY:?err_APISIX_CONSUMER_KEY_not_set_in_.env}
    - CONTENTMCP__SERVER__TLS__ENABLED=${CONTENT_MCP_TLS_ENABLED:-false}
    - CONTENTMCP__SERVER__TLS__CERT_DIR=/app/certs
    - CONTENTMCP__SERVER__TLS__CERT_FILE=/app/certs/server.crt
    - CONTENTMCP__SERVER__TLS__KEY_FILE=/app/certs/server.key
    - CONTENTMCP__LOG__OUTPUT=both
    - CONTENTMCP__LOG__FILE=/app/logs/app-content-mcp.log
  ports: ["127.0.0.1:${APP_CONTENT_MCP_PORT:-8019}:8019"]
  volumes:
    - app_content_mcp_logs:/app/logs
    - ./app-go/app-content-mcp/certs:/app/certs
  restart: unless-stopped
  networks: [mind-base-net]
```

启动 / 构建：

```bash
# 与主栈一起（默认 profile 已包含；先在 .env 填 CONTENT_MCP_UID / CONTENT_MCP_AUTH_TOKEN）
docker compose up -d app-content-mcp
# 或随 content-mcp profile
docker compose --profile content-mcp up -d app-content-mcp

# 若构建时模块下载被网络重置，可用宿主代理构建：
docker compose build --build-arg HTTP_PROXY=http://host.docker.internal:10808 \
                     --build-arg HTTPS_PROXY=http://host.docker.internal:10808 app-content-mcp

# 本地运行（stdio；宿主机无法直达 compose 网络内的 apisix，需自行打通网关访问）
cd app-go/app-content-mcp && go run . --transport http --http-addr :8019
```

> **端口语义**：容器与宿主统一 8019（原三服务占用的 8005/8009/8012 全部释放）；宿主 8014 归 app-kg health，保持不变。
> compose 内 app-ts 直连 `http://app-content-mcp:8019/mcp`，不经宿主端口。

## 十、MCP 宿主注册

ZCode / Claude 等支持远程 MCP 的宿主（streamable-http，带认证头）：

```json
{
  "mcpServers": {
    "app-content-mcp": {
      "url": "http://127.0.0.1:8019/mcp",
      "headers": { "Authorization": "Bearer <CONTENT_MCP_AUTH_TOKEN>" }
    }
  }
}
```

stdio 传输的宿主（本地直跑二进制时）：

```json
{
  "mcpServers": {
    "app-content-mcp": {
      "command": "go",
      "args": ["run", "."],
      "cwd": "app-go/app-content-mcp",
      "env": {
        "CONTENTMCP__UPSTREAM__BASE_URL": "http://127.0.0.1:9080",
        "CONTENTMCP__UPSTREAM__API_KEY": "<APISIX_CONSUMER_KEY>",
        "CONTENTMCP__UPSTREAM__UID": "<uid>"
      }
    }
  }
}
```

> stdio 模式日志强制走 stderr——stdout 是 JSON-RPC 协议通道，这是 MCP 约定。

## 十一、从旧三服务迁移与回滚

| 旧 | 新 |
|----|----|
| `app-board-mcp`（8005，镜像 `atoncooper/mind-base-app-board-mcp`，env `BOARDMCP__`） | `app-content-mcp`（8019，镜像 `atoncooper/mind-base-app-content-mcp`，env `CONTENTMCP__`） |
| `app-note-mcp`（8009，env `NOTEMCP__`） | 同上（同一进程，note 工具面） |
| `app-quiz-mcp`（8012，env `QUIZMCP__`） | 同上（同一进程，quiz 工具面） |
| 三个日志卷 `app_board_mcp_logs` / `app_note_mcp_logs` / `app_quiz_mcp_logs` | 一个卷 `app_content_mcp_logs` |
| 证书目录 `mcp/app-board-mcp/certs` | `app-go/app-content-mcp/certs` |
| app-ts 配置 `boardMcp` / `noteMcp` / `quizMcp` 三段 | 一段 `contentMcp`（`CONTENT_MCP__URL=http://app-content-mcp:8019/mcp`、`CONTENT_MCP__API_KEY=${APISIX_CONSUMER_KEY}`） |
| `.env` `BOARD_MCP_UID` / `BOARD_MCP_AUTH_TOKEN` / `NOTE_MCP_*` / `QUIZ_MCP_*` | `CONTENT_MCP_UID` / `CONTENT_MCP_AUTH_TOKEN` |

**不变项（迁移时无需改）**：12 个工具名/参数/返回文案、board resources/prompts、SSE 协议、前端、
APISIX 三条 internal 路由与 consumer、app-content 的 `/internal/*` 契约、uid 红线语义。

**迁移步骤**：
1. 停旧三容器并删旧服务定义（compose 同 PR 改）：`docker compose rm -f app-board-mcp app-note-mcp app-quiz-mcp`；
2. `.env` 把 `BOARD_MCP_UID`/`BOARD_MCP_AUTH_TOKEN` 换成 `CONTENT_MCP_UID`/`CONTENT_MCP_AUTH_TOKEN`（服务模式不需要）；
3. 起新容器并让 app-ts 用 `contentMcp` 配置重启；
4. smoke 验证（见 §十二），再删旧目录与旧镜像。

**回滚**：旧三个镜像 tag 保留即可回退 compose 与 app-ts 配置；工具名与协议未变，回滚不涉及数据。
证书目录在 gitignore 内，回滚后 cert-gen 重新生成即可。

## 十二、测试与冒烟

```bash
cd app-go/app-content-mcp
gofmt -l . && go vet ./... && go build ./... && go test ./...   # 全部测试在 tests/（黑盒）
```

- `tests/`（唯一测试面，`package tests` 黑盒）：upstream 客户端（httptest 伪造 app-content，覆盖头部注入/If-Match/content 两种形态/错误信封）、tools 12 工具 happy path + 校验失败 + 乐观锁 409 + search 截断 + 未配置守卫（经官方 in-process MCP client 调用）、resources 模板/read/动态 list、prompts 渲染与参数校验、serve 鉴权/Origin/限流/并发、config/logger/certs、以及单 binary 跨域 smoke（initialize/tools/list 12 工具）。`internal/**` 下无任何 `_test.go`。

单端口 smoke（compose 在跑）：

```bash
# 1. 探活（宿主可达，回环映射）
curl http://127.0.0.1:8019/health

# 2. /mcp 无凭证应 401；带 Origin 头应 403；带 Bearer 后 initialize 应 200 且 tools/list 返回 12 个工具
curl -s -X POST http://127.0.0.1:8019/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <CONTENT_MCP_AUTH_TOKEN>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'

# 3. 服务模式：apikey + X-Uid（三域路由均 401/200 语义不变）
#    /internal/board/boards?page=1&page_size=5、/internal/note/notes、/internal/quiz/* 经 APISIX
#    缺 apikey 应 401；带 apikey + X-Uid 应 200
```

> 已实测（迁移前三分服务形态，2026-09）：health 200；key-auth 401/200；initialize/tools/list；
> create → get（content 解析为对象）→ update（自动锁版本）→ search → delete 全链路，UTF-8 中文往返无损。
> 合并后单端口 smoke：`/health` 200、`/mcp` 无凭证 401、tools/list 12 个工具。

## 十三、约束与红线

- ❌ 工具面不得加入 uid 参数：Bearer 模式身份=配置固定 uid；服务模式身份=app-ts 会话经请求头注入的 X-Uid——**uid 永不出现在 LLM 可写的参数里**
- ❌ 不直连 app-content（必须经 APISIX key-auth 的 `/internal/{board,note,quiz}/*` 路由）；`/internal/*` 不暴露到 nginx
- ❌ 三个域（`internal/upstream/*` 与 `internal/mcp/tools/*` 的 board/note/quiz）禁止互相 import；唯一组合根是 `main.go`
- ❌ http 传输必须至少一种凭证（Bearer 或服务 apikey），双缺拒启（fail-closed）；Origin 默认拒绝、限流/并发/body 上限不得放宽
- ❌ 工具日志不得记录文档正文/笔记正文/题目/答案/批改文本与标题文本；只记长度与安全参数
- ✅ 每次上游调用生成 `X-Request-Id`；错误消息透传服务端 `detail` + `request_id`；`[CONTENTMCP]` 日志前缀
- ✅ stdio 模式日志走 stderr（stdout 是 JSON-RPC 协议通道）
- ✅ 新增工具须同步更新本文档与 AGENTS.md §2.11，并确认工具名/参数保持向后兼容
- ⚠️ **单 Bearer token 的能力面扩大**：合并后一个外部 token 可触达全部 12 个工具（原分服务各 6/4/2）。当前外部宿主非主路径；
  若日后要最小权限，在 serve.Auth 之后加 per-token 工具白名单（不改工具契约）。
- ⚠️ **故障域合并**：三域共用同一 MCP 进程（它们本来就共用 app-content 进程）；单进程 panic 由 recovery 中间件兜底。
