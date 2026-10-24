# 系统架构总览

> 本文是全系统的架构地图：服务清单、端口、请求路由、数据归属。改动了 compose / APISIX / nginx 后请同步更新本文。

MindBase 是多服务系统：**app-ts**（Node/Fastify，AI 域：chat/agent/RAG/KG AI/向量化/quiz AI/task-quiz/blindspot/skills）、一组 **app-go** Go 微服务（auth/bili/note/quiz/cloud/kg/settings/admin 各域权威）、**app-pay**（Java Spring Boot 交易/会员）、**app-board**（Go 板存储）、一个 Next.js 前端（`frontendv2/`）、分享审核后台 Compose 入口 **app-admin**（Nginx UI，:3001 回环）+ **app-admin-api**（Go API，:8016 回环）以及一组基础设施容器。

> ⚠️ **Python backend（`app/`）已于 2026-10-06 彻底退役**：compose 无 backend 服务、APISIX 无 backend upstream 与 catch_all 兜底（未列举路径一律 404，新端点必须显式加路由）。退役过程见 [python-decommission.md](archive/python-decommission.md)。

```
浏览器
  │
  ▼
nginx :80 / :443（TLS 终止 + 静态页 + 缓存）
  │
  ├── /minio-proxy/ ────────────────────────────► minio :9000（同源代理预签名 URL）
  ├── /cloud/（5GB 上传绕网关）─ auth_request ──► app-cloud :8007
  │
  ▼  其余 API（X-Requested-With: XMLHttpRequest 双用途分发）
APISIX :9080（容器内；鉴权 + 路由 + 限流）
  │ forward-auth: 调 app-auth /internal/auth/verify，注入 X-Uid / X-Roles
  │ key-auth:     服务间端点（/internal/*、/tasks/register 等）
  │
  ├──► app-ts :8000        AI 域（chat/agent/RAG/向量化/KG AI/quiz AI/task-quiz/blindspot/skills）
  ├──► app-auth :8006      认证权威（登录/会话/账户/RBAC/验证码）
  ├──► app-cloud :8007     云盘权威（配额/分享/回收站/workspaces/解析向量化）
  ├──► app-note :8008      笔记权威（CRUD/锚点/修订/分享）
  ├──► app-bili :8010      B站获取权威（收藏夹同步/ASR/build 编排）
  ├──► app-quiz :8011      quiz 存储权威（历史/错题/导出/分享/定时出题 detail+answer）
  ├──► app-settings :8015  用户偏好/壁纸（preferences/wallpaper；BYOK 已退役）
  ├──► app-task :8001      定时任务执行器（独立仓库镜像）
  ├──► app-pay :8002       Java 交易/会员（HTTPS-only，回环暴露）
  └──► app-board :8004     思维导图/白板存储（HTTPS-only）
```

服务间协作（不经 APISIX）：app-ts → app-kg 走 **gRPC**（:8013）；app-ts/app-go 各服务经内网直连 MySQL/Mongo/Redis/Milvus/Neo4j/MinIO/Higress。

**管理台（不经主站 nginx/APISIX）**：UI `app-admin :3001` 与 API `app-admin-api :8016` 都仅回环；浏览器访问 UI，UI Nginx 同源代理 `/api`。API 直连共享 MySQL 读用户/分享元数据、只写 `cloud_shares` 审核 4 列；受控内容预览（Issue #154）经 app-cloud `GET /internal/cloud/admin-review/*`（Bearer 共享令牌）换取短时效内联授权，每次查看落 `admin_audit`。`app-cloud` 同时负责审核列 schema migration，但不代理 admin 查询。

开发模式（不跑 compose）下没有 nginx/APISIX：前端 dev server :3000 经 `next.config.ts` 的 rewrites 把 API 转发到 APISIX :9080（dev 网关），见 [getting-started.md](getting-started.md)。

---

## 服务清单（docker-compose.yml）

默认 profile（裸 `docker compose up -d`）即启动**全栈**；其余 profile 是在全栈之上追加或单独启用。

| 服务 | 实现 | 容器端口 | 宿主端口（回环调试口） | Profile | 说明 |
|------|------|---------|---------|---------|------|
| app-ts | Node 20 + Fastify（`app-ts/`） | 8000 | 127.0.0.1:8000 | 默认（ts） | AI 域唯一实现（沿用退役 Python backend 的端口） |
| app-auth | Go + Gin（`app-go/app-auth/`） | 8006 | 127.0.0.1:8006 | 默认（auth） | 认证权威；APISIX forward-auth 后端 |
| app-cloud | Go + Gin（`app-go/app-cloud/`） | 8007 | 127.0.0.1:8007 | 默认（cloud） | 云盘权威 + workspaces |
| app-note | Go + Gin（`app-go/app-note/`） | 8008 | 127.0.0.1:8008 | 默认（note） | 笔记权威 |
| app-bili | Go + Gin（`app-go/app-bili/`） | 8010 | 127.0.0.1:8010 | 默认（bili） | B站获取权威 + ASR |
| app-quiz | Go + Gin（`app-go/app-quiz/`） | 8011 | 127.0.0.1:8011 | 默认（quiz） | quiz 存储权威 |
| app-kg | Go + gRPC（`app-go/app-kg/`） | 8013 gRPC / 8014 health | 127.0.0.1:8013/8014 | 默认（kg） | KG 图存储权威（Neo4j 全部 Cypher） |
| app-settings | Go + Gin（`app-go/app-settings/`） | 8015 | 127.0.0.1:8015 | 默认（settings） | 用户偏好/壁纸（BYOK 已于 2026-10-07 退役） |
| app-board | Go + Gin（`app-board/`） | 8004 | 无（仅容器网络） | 默认（board） | 板存储（HTTPS-only） |
| app-board-mcp | Go + mcp-go（`mcp/app-board-mcp/`） | 8005 | 127.0.0.1:8005 | 默认（board） | 板能力 MCP server（agent 用） |
| app-note-mcp | Go + mcp-go（`mcp/app-note-mcp/`） | 8009 | 127.0.0.1:8009 | 默认（note） | 笔记 MCP server（agent 用） |
| app-quiz-mcp | Go + mcp-go（`mcp/app-quiz-mcp/`） | 8012 | 127.0.0.1:8012 | 默认（quiz） | quiz MCP server（agent 用） |
| app-task | Go + Gin（独立仓库 [atoncooper/app-task](https://github.com/atoncooper/app-task)，镜像 `atoncooper/app-task`） | 8001 | `${APP_TASK_PORT:-8001}` | 默认（task） | 定时任务执行器 + 邮件投递 + WebUI |
| app-pay | Java 21 / Spring Boot 3（`app-pay/`） | 8002 | 127.0.0.1:8002 | pay | 交易/会员（HTTPS-only） |
| app-pay-test | 同 app-pay 镜像 | 8002 | 127.0.0.1:18002 | pay-test | 测试实例（强制 MOCK 渠道，整库隔离） |
| app-pay-admin | Go + Gin（`app-pay-admin/`） | 8003 | 127.0.0.1:8003 | pay-admin | 支付后台管理控制台（不经 APISIX） |
| app-admin | Nginx（静态 SPA；配置 `nginx/app-admin.conf`） | 80 | 127.0.0.1:3001 | 默认 / admin | 分享审核 UI；同源 `/api` 代理至 app-admin-api |
| app-admin-api | Go + Gin（`app-go/app-admin/`） | 8016 | 127.0.0.1:8016 | 默认 / admin | 直连 MySQL；只读用户/分享元数据 + 审核 4 列；不经 APISIX（详见 [app-admin.md](app-admin.md)） |
| higress | Higress all-in-one | 8080 gw / 18081 console | 127.0.0.1:18080 / :18081 | ai | AI 网关：平台 LLM/embedding/rerank/ASR 出网统一入口 + 计量 |
| frontend | Next.js 16（`frontendv2/`） | 3000 | `${FRONTEND_PORT:-3000}` | 默认（standalone） | 用户端 SPA（standalone 构建） |
| nginx | nginx:alpine | 80 / 443 | 80 / 443 | 默认（standalone） | 统一入口：TLS、页面/接口分发、缓存 |
| apisix | apache/apisix:3.11 | 9080 | 无宿主端口 | 默认（standalone） | API 网关：forward-auth / key-auth / 路由 / 限流 |
| mysql | mysql:8.4 | 3306 | `${MYSQL_PORT:-3306}` | 始终 | 主库 `mind_base`（`db/system.sql` 初始化） |
| mongo | mongo:7 | 27017 | `${MONGO_PORT:-27017}` | 始终 | 库 `mind_base`（Go 服务 + 共享集合）与 `mind_base_ts`（app-ts 自有） |
| redis | redis:7 | 6379 | — | 始终 | 限流/验证码/quota/分享缓存/`bili:page_ready` 事件桥 |
| etcd | etcd v3.5 | — | — | 默认（standalone） | APISIX 配置存储 + Milvus 元数据 |
| minio | MinIO | 9000 / 控制台 9001 | 9001 | 默认（standalone） | 云盘对象 `drive-videos` / 技能 zip / 壁纸 |
| milvus | milvus v2.6 standalone | 19530 | 19530 | 默认（storage） | 向量库（Milvus database `mind_base_ts`：`bilibili_videos` / `cloud_drive` / `kg_entities`） |
| neo4j | neo4j 5 community | 7474 / 7687 | — | 默认（storage） | 知识图谱图结构（权威写者 = app-kg） |
| app-task-mysql | mysql:8.4 | 3306 | 无 | 默认（task） | app-task 独立库 `app_task` |
| app-pay-mysql | mysql:8.4 | 3306 | 127.0.0.1:3307 | 默认（pay） | 交易库 `app_pay` |
| app-pay-test-mysql | mysql:8.4 | 3306 | 127.0.0.1:18306 | pay-test | 测试库 `app_pay_test` |
| redis-commander / mongo-express | — | 8081 | 8081 / 8082 | tools | 管理界面 |

profile 汇总：

| 命令 | 启动范围 |
|------|---------|
| `docker compose up -d` | 全栈（frontend/nginx/apisix/全部存储/app-ts/app-go 八服务含 app-admin/app-task/app-board 全家/app-pay-mysql） |
| `--profile ai` | + higress（AI 出网网关；平台 AI 流量强依赖，生产必开） |
| `--profile pay` | + app-pay |
| `--profile pay-test` | + app-pay-test（测试实例） |
| `--profile pay-admin` | + app-pay-admin |
| `--profile admin` | + app-admin（默认 profile 已含） |
| `--profile full` | 全部以上（含 tools 管理界面） |
| `--profile tools` | redis-commander / mongo-express |

（`standalone`/`storage`/`ts`/`auth`/`cloud`/`note`/`quiz`/`bili`/`kg`/`settings`/`board`/`task` 等单域 profile 用于在最小集合上单独操作某个服务；裸 `up` 已含全部默认服务。）

另有一个独立 compose：`docker-compose.daytona.yml`（自托管 Daytona 代码沙箱）。

---

## 请求路由（nginx → APISIX → 服务）

### nginx（`nginx/nginx.conf` + `locations.conf`）

- 80 / 443 两个 server 共用 `locations.conf`；443 用 `nginx/certs/` 自签开发证书（`scripts/gen-nginx-dev-cert.sh` 生成）。
- **页面路由（→ frontend）**：`/`、`/chat`、`/notes`、`/quiz`、`/favorites`、`/tasks`、`/skills`、`/settings`、`/blindspot` 等精确路径返回 SPA；`/wallpapers/` 静态资源。
- **双用途分发**：既是前端页面又是 API 前缀的路径（如 `/tasks`、`/notes`），通过 `X-Requested-With: XMLHttpRequest` 请求头区分——API 请求内部改写转 APISIX，页面请求转 frontend 并走缓存。
- **API 转发（→ apisix）**：`/auth` `/chat`（SSE 关缓冲）`/knowledge` `/asr` `/vec` `/notes` `/quiz` `/board/` `/task-quiz/` `/tasks` `/skills` `/blindspot` `/preferences` `/wallpaper` `/workspaces` 等。
- **直连（绕 APISIX）**：`/cloud/` → app-cloud（5GB 上传；身份经 auth_request 子请求向 app-auth 验证并注入 X-Uid/X-Roles；`/cloud/s/` 公开分享免鉴权）；`/minio-proxy/` → minio。

### APISIX（`apisix/apisix.yaml`，declarative standalone，无 catch_all）

| 路由（前缀） | 上游 | 鉴权 |
|--------------|------|------|
| `/auth` `/auth/*` | app-auth:8006 | 自校验 Bearer + 限流 |
| `/chat/ask/agent/stream` `/chat/ask/stream` `/chat/sessions*` `/chat/history*` `/chat/board/complete` `/chat/documents` | app-ts | forward-auth → `X-Uid`/`X-Roles` |
| `/chat/search` `/vec` `/vec/*` `/knowledge/{stats,folders/status,pages/vectorized,clear,video*}` `/blindspot*` `/skills*` | app-ts（`vec_knowledge_ts`，priority 55） | forward-auth |
| `/knowledge/kg*` | app-ts（`kg_ts`） | forward-auth |
| `/knowledge/build*` `/knowledge/folders/sync` `/favorites*` `/asr*` | app-bili | forward-auth |
| `/notes*` | app-note | forward-auth（`/notes/shared/{token}` 宽验证免登录） |
| `/quiz/*`（history/错题/导出/分享/详情） | app-quiz（priority 50） | forward-auth |
| `/quiz/generate` `/quiz/generate-from-summary` `/quiz/submit` | app-ts（priority 100/110 压过 quiz_user） | forward-auth |
| `/tasks/{id}/detail` `/tasks/{id}/answer` | app-quiz（priority 100） | forward-auth |
| `/task-quiz/chat` `/task-quiz/register` `/internal/quiz/generate-llm` `/internal/quiz/status/*` | app-ts | 前两者 forward-auth；后两者 key-auth（app-task 执行器回调） |
| `/tasks` `/tasks/*` `/tasks/register` `/scripts*` `/internal/task/*` `/internal/email/send` | app-task | 用户面 forward-auth；服务面 key-auth |
| `/cloud` `/cloud/*` | app-cloud | forward-auth |
| `/workspaces*` | app-cloud（`workspaces_user`） | forward-auth |
| `/notes*` 之外的 `/internal/note/*` `/internal/board/*` `/internal/quiz/*` | app-note / app-board / app-quiz | key-auth（MCP/服务间） |
| `/preferences*` `/wallpaper/*` | app-settings（`prefs_wallpaper_user`） | forward-auth |
| `/pay/*` | app-pay（https） | forward-auth（`/pay/callback/*` 免登录渠道验签） |
| `/internal/pay/*` | app-pay（https） | key-auth |
| `/board/*` | app-board（https） | forward-auth（OPTIONS 预检免鉴权） |

forward-auth 统一调 app-auth 的 `POST /internal/auth/verify` 宽验证 `Authorization: Bearer <bili_session>`：无凭证放行（公有端点），无效 401，有效则经 proxy-rewrite **剥离客户端伪造的头**后注入 `X-Uid`/`X-Roles`。**下游服务信任网关注入的头，不自验会话；nginx `/cloud/` 的 auth_request 语义相同。**

---

## 数据归属（单一数据源）

| 数据 | 存储 | 所有者 / 说明 |
|------|------|------|
| 认证 9 表（users/user_tokens/user_oauth/user_profile/user_device/verification_codes/login_attempts/rbac_*） | MySQL `mind_base` | app-auth（schema 权威，CREATE-only） |
| 获取域 5 表（collection/favorite_folders/video/video_versions/async_tasks） | MySQL `mind_base` | app-bili；`video.is_vectorized*`/`kg_*` 列分属 app-ts 账本陈旧化 / app-kg |
| 笔记 3 表（notes/note_anchors/note_shares） | MySQL `mind_base` | app-note |
| quiz 6 表（quiz_sets/quiz_submissions/quiz_answers/quiz_questions/quiz_task/quiz_task_answer） | MySQL `mind_base` | app-quiz |
| 云盘 3 表（cloud_files/cloud_folders/cloud_shares）+ cloud_refs + workspaces/workspace_bindings | MySQL `mind_base` | app-cloud；`cloud_shares` 的 moderation 4 列由 app-admin 写（同库，审核即时生效） |
| 管理台 3 表（admin_user/admin_session/admin_audit） | MySQL `mind_base` | app-admin 自有（仅 CREATE IF NOT EXISTS） |
| 用户偏好（user_preferences） | MySQL `mind_base` | app-settings（BYOK 三表已于 2026-10-07 退役删除） |
| 板元数据（board 表，AutoMigrate） | MySQL `mind_base` | app-board |
| ASR 正文 / quiz 题目正文 / 板正文 | Mongo `mind_base`（`asr_documents`/`quiz_questions`/`task_quiz_questions`/`board_documents`） | app-bili / app-quiz / app-board 写；app-ts 跨库**只读** `asr_documents` |
| 聊天会话/消息、会话总结、向量账本（vec_pages/vec_tasks）、技能元数据、KG 构建、会话文档 | Mongo `mind_base_ts` | app-ts 自有库（旧 Python 聊天历史不迁移） |
| 向量 | Milvus（database `mind_base_ts`：`bilibili_videos`/`cloud_drive`/`kg_entities`） | app-ts（写）；MySQL `video.is_vectorized*` 列已陈旧不再消费 |
| 知识图谱图结构 | Neo4j | app-kg 唯一写者；app-ts AI 编排经 gRPC |
| 文件（云盘/技能 zip/壁纸） | MinIO | 预签名 URL 经 `/minio-proxy/` 同源访问 |
| 限流/验证码/quiz quota/分享缓存/事件桥（`bili:page_ready`） | Redis | app-auth / app-quiz / app-ts；app-board 用 db 2 |
| 定时任务定义/日志/邮件队列/WebUI 账户 | MySQL `app_task` | app-task 独有 |
| 订单/会员/支付事件/回调流水/SKU/job lock | MySQL `app_pay`（Flyway 迁移） | app-pay 独有；pay-admin 只读共享 + 补偿开通 |
| 桌面端全部数据 | 本机 SQLite | mind-base-desktop 完全本地，不经网络后端 |

## 配置体系

没有中心配置；各服务独立配置，均读项目根 `.env`（密钥/连接串，见 [.env.example](../.env.example)），普通配置在各自 YAML：

| 服务 | 配置入口 | 环境前缀 | 文档 |
|------|---------|---------|------|
| app-ts | `app-ts/src/config/`（`default.yaml` + 环境变量） | 无前缀 env + 共享 `MONGO__URI`/`REDIS__URL`/`AI_GATEWAY__*` | [app-ts/AGENTS.md](../app-ts/AGENTS.md) |
| app-go 各服务 | `internal/config/default.yaml`（embed）← env 覆盖 | `APPAUTH__` / `APPCLOUD__` / `APPNOTE__` / `APPBILI__` / `APPQUIZ__` / `APPKG__` | AGENTS.md §2.13-2.19 |
| app-task | 独立仓库 `default.yaml`（嵌入镜像） | `APPTASK__` | [app-task.md](app-task.md) |
| app-pay | `application.yaml` + docker/test profile（Flyway 管 schema） | `PAY_*` / `ALIPAY_*` | [app-pay.md](app-pay.md) |
| app-pay-admin | `default.yaml`（嵌入）+ config 覆盖层 | `PAYADMIN__` | [app-pay-admin.md](app-pay-admin.md) |
| app-admin | `default.yaml`（嵌入）+ config 覆盖层 | `APPADMIN__` | [app-admin.md](app-admin.md) |
| app-board / 三个 MCP | `default.yaml`（嵌入） | `APPBOARD__` 等 | [app-board.md](app-board.md) / [app-board-mcp.md](app-board-mcp.md) |

AI 出网统一走 Higress 网关（`AI_GATEWAY__*`，见 AGENTS.md §2.10）；供应商 key 只在网关与 `.env`，不进代码与日志。

## app-ts 内部架构

```
src/
  index.ts             薄启动器（进程启动）
  bootstrap/           组合根：全部 DI 装配（数据端口→RAG→tools→agents→harness→HTTP）
  transport/           网络边界：http/server+routes、sse.ts 帧协议、grpc.ts、internal-client
  services/            业务编排（chat/quiz/task-quiz/blindspot/session-summary/skills/向量化…）
  {agent,tools,harness}/  agent 编排（main + note/code/quiz/board 子 agent）+ 工具层 + 门面
  {rag,kg}/            RAG 包（chunk/embed/rerank/rrf/Milvus 适配）+ KG AI 编排
  repository/          契约在根目录，实现按 memory/ mongo/ grpc/ 归位
  config/              配置加载；prompts/*.md = agent 提示词；test/ = vitest 离线单测
```

请求链路（问答）：`POST /chat/ask/agent/stream` → admission（会员加权排队）→ ChatService → AgentHarness → ReAct loop（工具并发执行）→ SSE（route/chunk/reasoning/step/sources/done/error）。

## CI/CD（.github/workflows）

| Workflow | 范围 | 内容 |
|----------|------|------|
| ci-frontend | `frontendv2/**` | tsc --noEmit + ESLint + next build |
| ci-app-ts | `app-ts/**` | typecheck + vitest |
| ci-app-bili / ci-app-note / ci-app-quiz / ci-app-settings / ci-app-kg | 对应 Go 服务 | gofmt / vet / test / build |
| ci-app-pay | `app-pay/**` | mvn test（纯 JUnit，无外部 DB） |
| ci-pay-admin | app-pay-admin | gofmt / vet / test / build |
| ci-app-admin | app-go/app-admin | gofmt / vet / test / build |
| ci-frontend-admin | frontend-admin | tsc --noEmit + vite build |
| docker-build | push main / tag | 构建并发布 18 个镜像到 Docker Hub（`atoncooper/mind-base-*`：frontend/app-auth/app-cloud/app-note/app-bili/app-quiz/app-kg/app-settings/app-ts/app-board/app-board-mcp/app-note-mcp/app-quiz-mcp/certgen/minio/app-pay-admin/app-admin/app-pay；需仓库 secrets `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN`） |
| desktop-release | tag `mind-base-desktop-v*` | Tauri 桌面端构建（Windows NSIS + macOS dmg）并发布 Release |
