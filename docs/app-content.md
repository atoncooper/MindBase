# app-content — 内容域服务（笔记 + 测验 + 思维导图/白板）

> 由原 **app-note**（笔记，8008）+ **app-quiz**（quiz 存储，8011）+ **app-board**（板存储，8004 HTTPS）三个 Go 服务合并（2026-11-07）。单 Go module / 单镜像 / 单容器 / 单进程（`app-go/app-content`，镜像 `atoncooper/mind-base-app-content`），三个独立 Gin engine 分别监听 **8004 / 8008 / 8011**；对外路径、wire 契约、DB schema、MCP 协议全部不变。
> MCP server（`app-note-mcp` / `app-quiz-mcp` / `app-board-mcp`）保持独立，仅上游服务名改为 app-content。

## 一、定位

| 维度 | 说明 |
|------|------|
| 角色 | 内容域三面：**note**=笔记权威（CRUD / 锚点 / 修订 / 分享 / markdown 消毒）；**quiz**=quiz 存储权威（历史 / 错题本 / 导出 / 详情 / 分享 / 定时出题 detail+answer）；**board**=板存储（CRUD / 乐观锁 / 置顶，HTTPS-only）。不做 AI 编排（出题/批改/笔记 agent 在 app-ts） |
| 技术栈 | Go 1.25 + Gin v1.12 + GORM（MySQL）+ mongo-driver v2 + go-redis v9（board 缓存 / quiz quota） |
| 端口 | 8004=board（**HTTPS-only**，TLS rotator 保留；仅经 APISIX 可达）、8008=note（HTTP）、8011=quiz（HTTP）；三端口均有 `/health` |
| 鉴权 | 用户路由信任 APISIX forward-auth 注入的 `X-Uid`；`/notes/shared/{token}`、`/quiz/shared/{token}` 免登录；board 同语义（非空正整数 uid 放行），不自验 bili_session |
| 存储 | MySQL `mind_base`：note 3 表 + quiz 6 表 + `board` 表（各域 CREATE-only / AutoMigrate，守护测试禁 ALTER）；Mongo：note `note_documents`/`note_revisions`、quiz `quiz_questions`/`task_quiz_questions`、board `MindBase.board_documents` |
| 配置 | 唯一 `app-go/app-content/default.yaml`（board/note/quiz 三段，embed）；env 前缀 `APPBOARD__` / `APPNOTE__` / `APPQUIZ__`；共享 env `RDBMS__URL`/`MONGO__URI`/`REDIS__URL` |
| 日志 | 单 logger（`internal/logger`）：stdout + `/app/logs`（lumberjack 轮转；日志卷 `app_content_logs`） |

## 二、目录与启动

```text
app-go/app-content/
├── cmd/app-content/main.go     # 组合根：config → 单 logger → board/note/quiz 三个 Run(ctx) 并发 → 优雅退出
├── default.yaml                # 唯一配置（board/note/quiz 三段，embed）
├── internal/
│   ├── config/                 # 一个配置入口；config/{board,note,quiz} 保留原 env 前缀
│   ├── app/{board,note,quiz}/  # 每域 Run(ctx, cfg)
│   ├── model/ repo/ service/ router/{board,note,quiz}/
│   ├── infra/{db,mongo,mongostore,redisstore,cache,tls}/
│   ├── logger/                 # 全局 logger（slog + Gin/GORM 适配 + request-id context）
└── tests/
```

```bash
cd app-go/app-content && go build ./... && go test ./...
go run ./cmd/app-content                 # 本地直跑（自工作目录向上读项目根 .env）
docker compose up -d app-content         # 容器形态
```

> 切流注意：旧 `app-note` / `app-quiz` / `app-board` 容器会占用 8008 / 8011 / 8004，必须先删除（`docker compose up -d --remove-orphans app-content` 或先 stop/rm 旧容器）。

> compose（server）：`profiles: ["", "content", "note", "quiz", "board", "full"]`；`depends_on` = cert-gen + mysql + mongo + redis；日志卷 `app_content_logs`；board TLS 证书挂载 `./app-board/certs:/app/certs`（`APPBOARD__SERVER__TLS__CERT_DIR=/app/certs`、`CERT=/app/certs/server.crt`、`KEY=/app/certs/server.key`）。client compose 核心服务无 profiles，note 宿主口默认 8008。

## 三、note 面（8008，HTTP）

基础路径 `/notes`（经 APISIX `notes_user` 路由，priority 50）。端点与契约沿用原笔记服务：

- CRUD：`GET/POST /notes`、`GET/PATCH/DELETE /notes/{uuid}`（PATCH 读 `If-Match`，冲突 409 结构化 detail）；
- 锚点 `POST /notes/{uuid}/anchors`、`DELETE .../anchors/{anchor_id}`；
- 修订 `GET /notes/{uuid}/revisions`（不含 content_md）、`POST .../revisions/restore/{revision_id}`；
- 分享 `POST /notes/{uuid}/share`、`DELETE /notes/{uuid}/share`；公开 `GET /notes/shared/{token}` 免登录；
- M2M：`/internal/note/*`（key-auth），供 app-note-mcp / 后端使用；
- 列表带 `X-Total-Count`；datetime 为 naive-UTC 格式；markdown 服务端二次消毒；仅保留单 active share。

AI 操作笔记一律经独立 MCP server `app-note-mcp`（8009，服务模式 apikey + X-Uid），不直连 note 面或存储。

## 四、quiz 面（8011，HTTP）

基础路径 `/quiz`、`/tasks`（APISIX `quiz_user` priority 50；`tasks_detail`/`tasks_answer` priority 100）：

- history（含 generating 超时 / done-but-empty stale 刷新）、错题本、三格式导出（jsonl/csv/sft）、详情（include_answers + data-lost→410）、两阶段删除、分享生命周期 + 公开分享页（免登录，Redis L2 60s 缓存 `mind-base:quiz_share:{token}`）；
- 定时出题业务面：`GET /tasks/{id}/detail`、`POST /tasks/{id}/answer`（确定性判题，无 LLM）；
- M2M：`/internal/quiz/*`（富 schema 生命周期）与 `/internal/quiz/quota/{peek,consume}`（共享 Redis 每日配额，Redis 不可用 fail-open）；
- wire 契约逐条复刻：`{"detail": ...}` 错误体；datetime 双格式；导出 CSV 行结尾 CRLF；分享响应体不含 correct_answer/explanation/keywords。

AI 出题/批改编排在 app-ts；AI 落库经 `app-quiz-mcp`（8012）或 app-ts 调 `/internal/quiz/*`。

## 五、board 面（8004，HTTPS-only）

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

cache-aside，只缓存读：`board:detail:{uid}:{uuid}` 与 `board:list:{uid}:{kind|all}:{page}:{pageSize}`（>1MB 的详情不缓存）。写直落 MySQL 并立即失效相关键；TTL（默认 300s）只是兜底。`APPBOARD__REDIS__URL` 留空则用 NoopCache；Redis 故障降级为缓存 miss，不影响正确性。

### 5.3 TLS

默认 `server.tls.enabled: true`（HTTPS-only），两种模式：

- **自动（默认）**：cert/key 留空 → 自动生成持久化开发 CA（`dev-ca.crt/key`，10 年）+ 叶子证书（`server.crt/key`，SAN 覆盖 localhost 等，825 天）。Rotator 每日巡检：余量 <30 天或文件丢失自动重签并经 `GetCertificate` 热切换。
- **显式**：`APPBOARD__SERVER__TLS__CERT/KEY` 指定文件（正式 CA 上线后用）。

compose 将证书目录挂到容器 `/app/certs`（宿主沿用 `./app-board/certs`，cert-gen 仍写这里）；APISIX 只读挂其中的 `dev-ca.crt` 到信任锚 bundle（`apisix.ssl.ssl_trusted_certificate`，**替换**默认池所以同时并入系统 CA）。首次起栈后 `/board/*` 报证书/502 时 `docker compose restart apisix` 刷新信任锚。

> APISIX 3.11 限制：HTTP 上游无法做证书校验（`tls.verify` 仅支持 kafka），因此健康检查 `https_verify_certificate: false`（只加密不验身份）；upstream 节点名 `app-content` 充当 SNI 命中叶子证书 SAN。

### 5.4 配置（board 段）

配置来源：嵌入 `default.yaml` ← `APPBOARD__` 环境变量（双下划线嵌套，最高优先级）；进程启动时顺带加载项目根 `.env`。密钥类（`rdbms.url`、`mongo.uri`）必须 env 注入，缺省拒绝启动。

```bash
APPBOARD__RDBMS__URL=mysql+aiomysql://mind_base:mind-base@mysql:3306/mind_base
APPBOARD__MONGO__URI=mongodb://admin:mind-base@mongo:27017/?authSource=admin
APPBOARD__MONGO__DB_NAME=MindBase
APPBOARD__REDIS__URL=redis://:mind-base@redis:6379/2   # 留空=禁用缓存
APPBOARD__SERVER__TLS__CERT_DIR=/app/certs
APPBOARD__SECURITY__CORS__ALLOW_ORIGINS=...            # 默认含 localhost:3000 与 https://localhost
APPBOARD__LOG__LEVEL / _FORMAT / _OUTPUT / _FILE__*
```

完整清单见 `.env.example` 与 `app-go/app-content/default.yaml`。

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

- `board` 表归 app-content 的 board 面所有（AutoMigrate），其它服务勿动该表
- 正文必须进 Mongo，MySQL 只存元数据（与笔记的分离存储同构）
- 不做 nginx 侧缓存与本地 L1 缓存（内容随编辑高频变化）
- 版本号是并发权威，任何写路径不得绕过 `If-Match`

## 六、配置（note / quiz 与端口）

note 面沿用 `APPNOTE__` 前缀（+ 共享 `MONGO__URI`）；quiz 面沿用 `APPQUIZ__` 前缀（+ 共享 `MONGO__URI`/`REDIS__URL`）；board 段配置见 §5.4。唯一默认值来源是 `app-go/app-content/default.yaml`（embed，board/note/quiz 三段）。

端口：服务内默认 8004 / 8008 / 8011，可用 `APPBOARD__SERVER__PORT` / `APPNOTE__SERVER__PORT` / `APPQUIZ__SERVER__PORT` 覆盖；compose 宿主回环映射用 `APP_CONTENT_NOTE_PORT`（默认 8018）/ `APP_CONTENT_QUIZ_PORT`（默认 8011），board 不映射宿主端口。完整清单见 [configuration.md](configuration.md)。

## 七、网关与 MCP

| 面 | 容器端口 | APISIX 路由 | upstream id |
|----|---------|-------------|-------------|
| note | 8008 | `notes_user`、`note_internal` | `upstream-app-content-note` |
| quiz | 8011 | `quiz_user`、`quiz_ai*`（AI 编排在 app-ts）、`tasks_detail`/`tasks_answer`、`quiz_internal` | `upstream-app-content-quiz` |
| board | 8004（https） | `board_user`、`board_internal` | `upstream-app-content-board` |

MCP server 保持独立，仅上游指向 app-content：`app-note-mcp`（8009）→ `/internal/note/*`；`app-quiz-mcp`（8012）→ `/internal/quiz/*`；`app-board-mcp`（8005）→ `/internal/board/*`。详见 [notes.md](notes.md)、[sharing.md](sharing.md)、[app-board-mcp.md](app-board-mcp.md)。

## 八、迁移与回滚

- 旧 `app-go/app-note/`、`app-go/app-quiz/`、根 `app-board/` 源码目录与 `app-note`/`app-quiz`/`app-board` compose 服务已删除（宿主 `app-board/certs` 证书目录刻意保留，见 §5.3）；历史实施记录见 [archive/app-note-migration.md](archive/app-note-migration.md)、[archive/app-quiz-migration.md](archive/app-quiz-migration.md)。
- 回滚 = 回退对应 commit 恢复旧三服务目录 / compose / APISIX 条目；数据库 schema 未变（无新增表），无需数据迁移。
- 共享 DB 既有迁移照常执行（三域 DDL 仍 CREATE-only）。

## 九、全局约束与红线

- ❌ 三个域之间禁止互相 import；跨域共享只允许 `internal/infra/*`（需新增共享契约时先抽独立 `contracts` 包再引用）
- ❌ 各域 Migrate 禁止 ALTER/DROP（改 schema 由所属域发起）
- ❌ AI/agent 禁止直连 app-content 或其存储：笔记/测验/板操作一律经对应 MCP server（uid 永不出现在 LLM 可写参数）
- ❌ board 8004 必须 HTTPS-only（TLS rotator 只作用于 board engine）；`board` 表归 board 面所有，其它服务勿动
- ❌ 公开分享响应不得含答案/解析；Redis 分享缓存键前缀与 TTL 不得单侧改动；datetime wire 格式不得改为 RFC3339/Z
