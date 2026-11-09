# app-content — 内容域服务（笔记 + 测验 + 思维导图/白板）

> 由原 **app-note** + **app-quiz** + **app-board** 三个 Go 服务合并（2026-11-07）。单 Go module / 单镜像 / 单容器 / **单进程、单端口、HTTPS-only**（`app-go/app-content`，镜像 `atoncooper/mind-base-app-content`）：三个域挂在同一个 Gin 引擎上，只有一个 HTTPS listener（**8004**），路径 `/board/*`、`/notes/*`、`/quiz/*`、`/tasks/*`、`/internal/*` 全部共用该端口；对外路径、wire 契约、DB schema、MCP 协议不变。
> MCP server 侧：2026-11-08（plan/1.0.20）原 `app-note-mcp` / `app-quiz-mcp` / `app-board-mcp` 三个 MCP server 已合并为**一个** `app-go/app-content-mcp`（单 module / 镜像 / 容器 / 端口 8019 / `/mcp` 端点，12 工具），上游仍经 APISIX 三条 internal 路由指向本服务；见 [app-content-mcp.md](app-content-mcp.md)。

## 一、定位

| 维度 | 说明 |
|------|------|
| 角色 | 内容域三面：**note**=笔记权威（CRUD / 锚点 / 修订 / 分享 / markdown 消毒）；**quiz**=quiz 存储权威（历史 / 错题本 / 导出 / 详情 / 分享 / 定时出题 detail+answer）；**board**=板存储（CRUD / 乐观锁 / 置顶，HTTPS-only）。不做 AI 编排（出题/批改/笔记 agent 在 app-ts） |
| 技术栈 | Go 1.25 + Gin v1.12 + GORM（MySQL）+ mongo-driver v2 + go-redis v9（board 缓存 / quiz quota） |
| 端口 | **单端口 8004（HTTPS-only）**：board/note/quiz 三面共用同一 listener（TLS rotator 保留；仅经 APISIX 可达）；一个 `/health` 汇总三域 MySQL 探活 |
| 鉴权 | 用户路由信任 APISIX forward-auth 注入的 `X-Uid`；`/notes/shared/{token}`、`/quiz/shared/{token}` 免登录；board 同语义（非空正整数 uid 放行），不自验 bili_session |
| 存储 | 进程级**一个** MySQL 池 + **一个** Mongo client + **一个** Redis client（三域共享 handle，不再各自连库）。MySQL `mind_base`：note 3 表 + quiz 6 表 + `board` 表（三面统一 CREATE-ONLY 迁移，禁用 AutoMigrate/ALTER）；Mongo：共享库 `mind_base` 存 note `note_documents`/`note_revisions`、quiz `quiz_questions`/`task_quiz_questions`，board 历史库 `MindBase` 存 `board_documents`（可用 `database.mongo.board_database` 显式配置，迁移后置空即统一） |
| 配置 | 唯一 `app-go/app-content/default.yaml`（进程级 app/server/security/log/observability + **唯一** database 段 + quiz 域参数，embed）；env 用 `CONTENT__` 前缀（`CONTENT__DATABASE__*` 等）；旧 `APPBOARD__`/`APPNOTE__`/`APPQUIZ__` 数据源变量兼容但必须一致；`CONTENT__INTERNAL_API_KEY`（/internal/* 二次校验，fail-closed） |
| 日志 | 单 logger（`internal/logger`）：stdout + `/app/logs`（lumberjack 轮转；日志卷 `app_content_logs`） |

## 二、目录与启动

```text
app-go/app-content/
├── cmd/app-content/main.go     # 组合根：config → 单 logger → bootstrap.Run(ctx)：单 listener 挂三域 + 优雅退出
├── default.yaml                # 唯一配置（board/note/quiz 三段，embed）
├── internal/
│   ├── config/                 # 一个配置入口；config/{board,note,quiz} 保留原 env 前缀
│   ├── bootstrap/              # 进程内组装：一个 Run、一个 Gin engine、一个 *http.Server；setup{Board,Note,Quiz} 只往同一 engine 注册路由
│   ├── dto/{board,note,quiz}/  # HTTP 边界：请求 DTO（binding 校验）+ 响应 DTO/mapper
│   ├── middleware/             # 统一 request-id/安全头/CORS/body limit/X-Uid/内部服务密钥
│   ├── model/ repo/ service/ router/{board,note,quiz}/
│   ├── infra/{db,mongo,mongostore,redisstore,cache,tls}/
│   ├── logger/                 # 全局 logger（slog + Gin/GORM 适配 + request-id context）
└── tests/
```

```bash
cd app-go/app-content && go build ./... && go test ./tests/   # 全部测试统一在 tests/ 包
go run ./cmd/app-content                 # 本地直跑（自工作目录向上读项目根 .env）
docker compose up -d app-content         # 容器形态
```

> 切流注意：旧 `app-note` / `app-quiz` / `app-board` 容器会占用 8008 / 8011 / 8004，必须先删除（`docker compose up -d --remove-orphans app-content` 或先 stop/rm 旧容器）；新服务只监听一个 8004。

> compose（server）：`profiles: ["", "content", "note", "quiz", "board", "full"]`；`depends_on` = cert-gen + mysql + mongo + redis；日志卷 `app_content_logs`；board TLS 证书挂载 `./app-board/certs:/app/certs`（`CONTENT__SERVER__TLS__CERT_DIR=/app/certs`、`CERT=/app/certs/server.crt`、`KEY=/app/certs/server.key`）。client compose 核心服务无 profiles，宿主调试口统一 `APP_CONTENT_PORT`（默认 8004）。

> 说明：`router` 只做路由注册 + DTO 绑定/映射；校验规则在 `dto/*` 的 binding tags，安全链在 `internal/middleware`（由组合根**统一 Apply 一次**，各域不再各自建 engine）。`internal/bootstrap` 是**唯一的组合根**——`Run(ctx, cfg)` 创建唯一 `gin.New()` engine，初始化三域后让它们在同一 engine 上注册路由（`/board/*`、`/notes/*`、`/quiz/*`、`/tasks/*`、`/internal/*`），再由同一个 `*http.Server` 在单一端口提供；per-domain body limit 由 middleware 按路径前缀选取。全模块只有一个 `main`；`tests/architecture_test.go` 守护“唯一 http.Server / 唯一 ListenAndServe / 唯一 gin.New() / 无 ServeMux”。三域之间目前没有任何直接调用；未来若需跨域能力，只能经对方 **service 接口**注入，不得跨域取 repo/router，也不得在进程内用 HTTP 回环调用自己。所有 Go 测试必须在 `tests/` 包（`internal/**` 下不允许 `_test.go`）。

## 三、note 面（单端口 8004，路径 `/notes/*`）

基础路径 `/notes`（经 APISIX `notes_user` 路由，priority 50）。端点与契约沿用原笔记服务：

- CRUD：`GET/POST /notes`、`GET/PATCH/DELETE /notes/{uuid}`（PATCH 读 `If-Match`，冲突 409 结构化 detail）；
- 锚点 `POST /notes/{uuid}/anchors`、`DELETE .../anchors/{anchor_id}`；
- 修订 `GET /notes/{uuid}/revisions`（不含 content_md）、`POST .../revisions/restore/{revision_id}`；
- 分享 `POST /notes/{uuid}/share`、`DELETE /notes/{uuid}/share`；公开 `GET /notes/shared/{token}` 免登录；
- M2M：`/internal/note/*`（key-auth），供 app-content-mcp（note 工具面）使用；
- 列表带 `X-Total-Count`；datetime 为 naive-UTC 格式；markdown 服务端二次消毒；仅保留单 active share。

AI 操作笔记一律经 MCP server `app-content-mcp`（8019 单端点，note 工具面；服务模式 apikey + X-Uid），不直连 note 面或存储。

## 四、quiz 面（单端口 8004，路径 `/quiz/*`、`/tasks/*`）

基础路径 `/quiz`、`/tasks`（APISIX `quiz_user` priority 50；`tasks_detail`/`tasks_answer` priority 100）：

- history（含 generating 超时 / done-but-empty stale 刷新）、错题本、三格式导出（jsonl/csv/sft）、详情（include_answers + data-lost→410）、两阶段删除、分享生命周期 + 公开分享页（免登录，Redis L2 60s 缓存 `mind-base:quiz_share:{token}`）；
- 定时出题业务面：`GET /tasks/{id}/detail`、`POST /tasks/{id}/answer`（确定性判题，无 LLM）；
- M2M：`/internal/quiz/*`（富 schema 生命周期）与 `/internal/quiz/quota/{peek,consume}`（共享 Redis 每日配额，Redis 不可用 fail-open）；
- wire 契约逐条复刻：`{"detail": ...}` 错误体；datetime 双格式；导出 CSV 行结尾 CRLF；分享响应体不含 correct_answer/explanation/keywords。

AI 出题/批改编排在 app-ts；AI 落库经 `app-content-mcp`（8019 单端点，quiz 工具面）或 app-ts 调 `/internal/quiz/*`。

## 五、board 面（单端口 8004，HTTPS-only，路径 `/board/*`）

为前端「思维导图」页面提供板（board）的存储、乐观并发与 pin 能力；白板（Excalidraw）存储契约已就绪，编辑器 P3 接入。

### 5.1 API

Base path：`/board`（经 APISIX `/board/*` 路由）。错误体 `{"detail": ...}`，500 附带 `request_id`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 探活 `{"status":"healthy"}` |
| GET | `/board/boards` | 列表（query：`kind`=`mindmap`\|`whiteboard`\|缺省全部，`page`、`page_size`） |
| POST | `/board/boards` | 创建 `{title?, kind?, content?}`（kind 默认 `mindmap`）→ 201 |
| GET | `/board/boards/:uuid` | 详情，响应头 `ETag: <version>` |
| PUT | `/board/boards/:uuid` | 更新，**必须带 `If-Match: <version>`**：缺失 → 428，不匹配 → 409 |
| DELETE | `/board/boards/:uuid` | 软删除 → 204 |
| PATCH | `/board/boards/:uuid/pin` | `{isPinned: bool}` |

并发模型：`version` 是乐观锁计数器，更新时 `If-Match` 比对后递增；所有查询按 uid 过滤（非本人与不存在一律 404）。写路径是 MySQL 元数据 + Mongo 正文的**双存储提交**，Mongo 失败自动回滚版本。

### 5.2 缓存（Redis，可选）

cache-aside，只缓存读：`board:detail:{uid}:{uuid}` 与 `board:list:{uid}:{kind|all}:{page}:{pageSize}`（>1MB 的详情不缓存）。写直落 MySQL 并立即失效相关键；TTL（默认 300s）只是兜底。`CONTENT__DATABASE__REDIS__URL` 留空则用 NoopCache；Redis 故障降级为缓存 miss，不影响正确性。

### 5.3 TLS

默认 `server.tls.enabled: true`（HTTPS-only），两种模式：

- **自动（默认）**：cert/key 留空 → 自动生成持久化开发 CA（`dev-ca.crt/key`，10 年）+ 叶子证书（`server.crt/key`，SAN 覆盖 localhost 等，825 天）。Rotator 每日巡检：余量 <30 天或文件丢失自动重签并经 `GetCertificate` 热切换。
- **显式**：`CONTENT__SERVER__TLS__CERT/KEY` 指定文件（正式 CA 上线后用）；`client_auth` 开启时用 `CONTENT__SERVER__TLS__CLIENT_CA_FILE` 指定客户端 CA bundle。

compose 将证书目录挂到容器 `/app/certs`（宿主沿用 `./app-board/certs`，cert-gen 仍写这里）；APISIX 只读挂其中的 `dev-ca.crt` 到信任锚 bundle（`apisix.ssl.ssl_trusted_certificate`，**替换**默认池所以同时并入系统 CA）。首次起栈后 `/board/*` 报证书/502 时 `docker compose restart apisix` 刷新信任锚。

> APISIX 3.11 限制：HTTP 上游无法做证书校验（`tls.verify` 仅支持 kafka），因此健康检查 `https_verify_certificate: false`（只加密不验身份）；upstream 节点名 `app-content` 充当 SNI 命中叶子证书 SAN。

### 5.4 配置（统一数据源）

配置来源：嵌入 `default.yaml` ← `CONTENT__` 环境变量（双下划线嵌套，最高优先级），进程启动时只加载一次项目根 `.env`。三域不各自持有 DSN/URI：**一个进程 = 一个 MySQL 池 + 一个 Mongo client + 一个 Redis client**。旧 `APPBOARD__` / `APPNOTE__` / `APPQUIZ__` 变量仍兼容，但取值冲突会启动失败（防止 board 与 note/quiz 静默连到不同库）。

```bash
CONTENT__DATABASE__MYSQL__URL=mysql+aiomysql://mind_base:mind-base@mysql:3306/mind_base
CONTENT__DATABASE__MONGO__URI=mongodb://admin:mind-base@mongo:27017/?authSource=admin
CONTENT__DATABASE__MONGO__DATABASE=mind_base        # 笔记/测验共享库
CONTENT__DATABASE__MONGO__BOARD_DATABASE=MindBase   # board 历史库（迁移后可留空=共享库）
CONTENT__DATABASE__REDIS__URL=redis://:mind-base@redis:6379/1   # 留空=缓存/配额降级
CONTENT__DATABASE__REDIS__KEY_PREFIX=mind-base:
CONTENT__SERVER__TLS__CERT_DIR=/app/certs
CONTENT__SECURITY__CORS__ALLOW_ORIGINS=...           # 默认含 localhost:3000 与 https://localhost
CONTENT__LOG__LEVEL / _FORMAT / _OUTPUT / _FILE__*
```

完整清单见 `.env.example` 与 `app-go/app-content/default.yaml`。另有进程级 `security.internal_api_key`（env `CONTENT__INTERNAL_API_KEY`）：`/internal/*` M2M 路由必须同时携带网关 key-auth 与 `X-Internal-Key`（APISIX 路由注入），未配置时 fail-closed（503）。

### 5.5 中间件

- `X-Request-Id`：透传（APISIX request-id 插件注入）或自生成，回写响应头并贯穿 slog
- CORS：白名单反射 + credentials，允许头含 `Authorization, Content-Type, If-Match, X-Request-Id, X-Requested-With`
- Body 限制 9MB（8MB 内容 + JSON envelope 余量）；Server 超时 read 60s / write 120s / idle 120s
- `SetTrustedProxies(nil)`：不信任 XFF

### 5.6 启动

```bash
# 与主栈一起（默认 profile 已包含）
docker compose up -d app-content

# 本地运行（从 app-go/app-content）
go run ./cmd/app-content

# 测试（无外部依赖，内存 fake）
cd app-go/app-content && go test ./...
```

### 5.7 前端接入

`frontendv2/lib/api/boards.ts` 封装上述 API（`If-Match` 乐观锁，409 → `BoardConflictError`），`lib/board-store.ts` 是桌面端（Tauri）`lib/mindmap.ts` 的 Web 版存储桥——对编辑器组件导出同一套契约（saveMindMap / getMindMap / 列表 / 图标包 / 模板 / 导出），桌面编辑器因此原样移植：图标包/模板/快照落 localStorage，导出走浏览器下载，文档内容走 boards API（409 自动重试一次，last-write-wins）。

入口：`/mindmap` 页面（Drive 风格列表 + 编辑器，800ms 防抖自动保存 + Ctrl+S）。

### 5.8 约束与红线（board）

- `board` 表归 app-content 的 board 面所有（CREATE-ONLY 迁移），其它服务勿动该表
- 正文必须进 Mongo，MySQL 只存元数据（与笔记的分离存储同构）
- 不做 nginx 侧缓存与本地 L1 缓存（内容随编辑高频变化）
- 版本号是并发权威，任何写路径不得绕过 `If-Match`

## 六、配置（note / quiz 与端口）

唯一默认值来源是 `app-go/app-content/default.yaml`（embed），分两层：

- **进程级**：`app`（env/debug/timezone）、`server`（单 HTTPS listener：host/port/http2/trusted_proxies/超时/TLS 1.2·1.3/client_auth/优雅关停）、`security`（内部密钥、request-id、安全头/HSTS、CORS、限流、三域 body limits）、`log`（level/format/output/add_source/轮转）、`observability`（health 超时、Prometheus /metrics、可选 pprof）。
- **数据层（进程级唯一）**：`database.mysql`（URL/池参数）、`database.mongo`（URI/共享库/board 历史库/超时）、`database.redis`（URL/键前缀/board 缓存 TTL）。三域共享同一组连接，不再有 per-domain DSN。
- **域级**：仅 `quiz` 的配额与生成超时（`quiz.quota` / `quiz.lifecycle`）；board/note 不再有独立配置段。

env 覆盖统一用 `CONTENT__SECTION__KEY`（如 `CONTENT__SECURITY__RATE_LIMIT__RPS=200`、`CONTENT__DATABASE__MYSQL__URL=...`）；旧 `APPBOARD__` / `APPNOTE__` / `APPQUIZ__` 数据源变量兼容但必须一致；旧 `APPBOARD__SERVER__*` / `APPBOARD__LOG__*` 继续映射到根 server/log。

> 完整字段、默认值与注释见 `default.yaml`：`server.tls.min_version`、`client_auth`、`http2`、`security.headers`、`cors`、`rate_limit`、`body_limits`、`observability.metrics/pprof` 等。

端口：**全服务只有一个 listener**，默认 8004，用 `CONTENT__SERVER__PORT` 覆盖（旧 `APPBOARD__SERVER__PORT` 兼容；`APPNOTE__SERVER__PORT` / `APPQUIZ__SERVER__PORT` 已废弃且不生效，域配置段已删除）；compose 宿主回环映射统一用 `APP_CONTENT_PORT`（默认 8004）。完整清单见 [configuration.md](configuration.md)。

## 七、网关与 MCP

| 面 | 路径（共用 8004） | APISIX 路由 | upstream id |
|----|------------------|-------------|-------------|
| note | `/notes/*`、`/internal/note/*` | `notes_user`、`note_internal` | `upstream-app-content-note` |
| quiz | `/quiz/*`、`/tasks/*`、`/internal/quiz/*` | `quiz_user`、`quiz_ai*`（AI 编排在 app-ts）、`tasks_detail`/`tasks_answer`、`quiz_internal` | `upstream-app-content-quiz` |
| board | `/board/*`、`/internal/board/*` | `board_user`、`board_internal`（key-auth 注入 `X-Internal-Key`，不再 rewrite 路径） | `upstream-app-content-board` |

> 三个 upstream 的节点都是 `app-content:8004`（scheme https, `tls.verify: false`，健康检查 https 且不验证书）——upstream id 保留只是为了路由/回滚粒度。

MCP server = **`app-content-mcp`**（8019 单端口单端点，12 工具合并；2026-11-08 plan/1.0.20）：note → `/internal/note/*`、quiz → `/internal/quiz/*`、board → `/internal/board/*`，三条 internal 路由与 consumer 零改动。详见 [app-content-mcp.md](app-content-mcp.md)、[notes.md](notes.md)、[sharing.md](sharing.md)。

## 八、迁移与回滚

- 旧 `app-go/app-note/`、`app-go/app-quiz/`、根 `app-board/` 源码目录与 `app-note`/`app-quiz`/`app-board` compose 服务已删除（宿主 `app-board/certs` 证书目录刻意保留，见 §5.3）；历史实施记录见 [archive/app-note-migration.md](archive/app-note-migration.md)、[archive/app-quiz-migration.md](archive/app-quiz-migration.md)。
- 回滚 = 回退对应 commit 恢复旧三服务目录 / compose / APISIX 条目；数据库 schema 未变（无新增表），无需数据迁移。
- 共享 DB 既有迁移照常执行（三域 DDL 仍 CREATE-only）。

## 九、全局约束与红线

- ❌ 三域 repo/router/model/infra 按域隔离、禁止互相 import；确需跨域能力只能依赖对方 **service 接口**（或中立契约包），不得进程内 HTTP 回环调用自己；由 `tests/architecture_test.go` 守护
- ❌ 各域 Migrate 禁止 ALTER/DROP（改 schema 由所属域发起）
- ❌ AI/agent 禁止直连 app-content 或其存储：笔记/测验/板操作一律经 `app-content-mcp`（uid 永不出现在 LLM 可写参数）
- ❌ 唯一 listener 必须 HTTPS-only（启动强制 TLS；TLS rotator 作用于该 listener）；`board` 表归 board 面所有，其它服务勿动
- ❌ 公开分享响应不得含答案/解析；Redis 分享缓存键前缀与 TTL 不得单侧改动；datetime wire 格式不得改为 RFC3339/Z

## 十、安全边界与防护（2026-11-07 审查）

**信任模型（必须理解）**

- 用户身份唯一来源是 APISIX forward-auth 注入的 `X-Uid`；app-content **不自验 bili_session**。APISIX 的 forward-auth 是“宽验证”：无凭证请求放行且不带 X-Uid，由各 handler 自己 401。因此**新增端点必须在 handler 首行取 `currentUID`**（board 在路由组级 `requireXUid`），否则会变成匿名可写端点。
- `/internal/{note,quiz,board}/*` 由 APISIX key-auth 保护；服务端对三面都再校验 `X-Internal-Key`（APISIX 注入，fail-closed），未配置或错误即 401/503，容器内可达调用方无法仅凭伪造 X-Uid 读写。board 现在有真实的 `/internal/board/*` 路由组（`InternalAuth` + `RequireUID`），APISIX 只做 key-auth 注入而不再 rewrite 到 `/board/*`。用户路由只信任 APISIX 注入的 X-Uid，因此**不要把 8004 暴露到公网**；k8s 建议为 app-content 加 NetworkPolicy（仅放行 APISIX/MCP/探针）。
- TLS：**服务只有一个 HTTPS listener（8004，TLS 1.2+）**，三域全部走 HTTPS；启动强制 `CONTENT__SERVER__TLS__ENABLED=true`（仅本地调试可用 `CONTENT__ALLOW_INSECURE_HTTP=true` 临时绕过）；`client_auth=request|require` 时必须提供 `server.tls.client_ca_file`，否则拒绝启动。APISIX 三个 upstream 均 `scheme: https`；nginx 终止外部 TLS 后经 APISIX 再用 HTTPS 访问本服务。生产证书私钥建议 0600 + 正式 CA/ cert-manager 替换 dev-CA。

**已实施的防护基线**

- 请求体上限：note 2 MiB、quiz 4 MiB、board 9 MiB（`http.MaxBytesReader`，字段级 256/512 KiB 内容上限之外的第一道闸）。
- HTTP server 超时：单端口统一 `ReadHeaderTimeout 10s / ReadTimeout 60s / WriteTimeout 120s / IdleTimeout 120s / MaxHeaderBytes 1 MiB`（防 slowloris）。
- 安全响应头：三面统一 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Cache-Control: no-store`（nginx 边缘另有 HSTS 等）。
- CORS：allowlist 反射 + `Allow-Credentials: true`；`APPBOARD|APPNOTE|APPQUIZ__...CORS__ALLOW_ORIGINS` 为**替换**语义（可收窄），`*` 在启动校验直接拒绝。
- 错误不泄漏：note 面 500 统一返回「内部错误」/503「存储暂不可用」，驱动/Mongo 错误只进日志（带 request_id）；board 500 返回 `{"detail","request_id"}`。
- 认证失败统一 401（原 board 为 400）；`X-Request-Id` 入站截断 64 字符并注入日志上下文（request_id 贯穿）。
- 日志文件：镜像预建 nonroot 属主 `/app/logs`；k8s emptyDir 通过 `fsGroup: 65532` 保证可写；容器以非 root + 丢弃全部 capability 运行。
- 分享令牌：note 32 字节 / quiz 16 字节 `crypto/rand`，公开分享为免登录只读，响应不含答案/解析。

**仍存在的风险（未在本次修复）**

1. 分享 token 出现在 URL 路径，会进 APISIX/nginx 访问日志；如需更强隐私，可在访问日志脱敏 `shared/{token}`。
2. note Markdown 消毒允许 `data:` URL（历史测试固定该行为）；XSS 最终防线仍依赖前端渲染器，建议后续收紧协议白名单。
3. note `PATCH` 的 `If-Match` 是“先读后写”（读-检查-按主键更新），并发写存在 TOCTOU 丢更新窗口；建议改条件更新 `WHERE updated_at = ?` 或行锁。
4. note 更新是 Mongo 正文先写、MySQL 元数据后写，无事务补偿；极端失败下正文与 content_hash/updated_at 短暂不一致；建议加补偿或在读路径以正文为准重建。
5. 用户写端点缺少 per-uid 配额（笔记/测验创建无限额，依赖 nginx 每 IP 限流）；如需运营级防滥用可在 service 层加每日配额。
6. ~~`apisix.yaml` 内置 consumer key~~ → 已改为模板渲染（`apisix/apisix.yaml.template` + `render-config.sh`，容器启动时从 env 注入；仓库不再存真实 key）。旧 key 已进 git 历史，生产应轮换一次。
