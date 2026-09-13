# 系统架构总览

> 本文是全系统的架构地图：服务清单、端口、请求路由、数据归属。改动了 compose / APISIX / nginx 后请同步更新本文。

MindBase 是多服务系统：一个 FastAPI 主后端（Agent 编排 + RAG + 业务）、多个独立的 Go / Java 微服务、一个 Next.js 前端，以及一组基础设施容器。

```
浏览器
  │
  ▼
nginx :80 / :443（TLS 终止 + 静态页 + 缓存）
  │
  ├── SPA页面 /wallpapers /minio-proxy ──────────► frontend :3000 / minio :9000
  │
  ▼  API 请求（大部分前缀）
APISIX :9080（容器内；鉴权 + 路由 + 限流）
  │ forward-auth: 调 backend /internal/auth/verify 验 bili_session，注入 X-Uid
  │ key-auth:    服务间端点（/internal/*、/tasks/register 等）
  │
  ├──► backend :8000        FastAPI 主后端（Agent/RAG/笔记/云盘/题库/凭证…）
  ├──► app-task :8001       Go 纯调度器（定时出题/定时任务 + 邮件投递 + WebUI 控制台）
  ├──► app-pay :8002        Java Spring Boot 交易/会员（HTTPS-only，回环暴露）
  └──► app-board :8004      Go 思维导图/白板存储（HTTPS-only，仅容器网络可达）
```

开发模式（不跑 compose）下没有 nginx/APISIX：前端 dev server :3000 经 `next.config.ts` 的 rewrites 把 API 转发到 APISIX :9080（或直连 backend :8000），见 [getting-started.md](getting-started.md)。

---

## 服务清单（docker-compose.yml）

默认 profile（裸 `docker compose up -d`）即启动**全栈**；其余 profile 是在全栈之上追加。

| 服务 | 实现 | 容器端口 | 宿主端口 | Profile | 说明 |
|------|------|---------|---------|---------|------|
| backend | FastAPI（本仓库 `app/`） | 8000 | `${APP_PORT:-8000}` | 默认 | 主后端：Agent/RAG/业务 API |
| frontend | Next.js 16（`frontendv2/`） | 3000 | `${FRONTEND_PORT:-3000}` | 默认 | 用户端 SPA（standalone 构建） |
| nginx | nginx:alpine | 80 / 443 | 80 / 443 | 默认 | 统一入口：TLS、页面/接口分发、缓存 |
| apisix | apache/apisix:3.11 | 9080（无宿主端口） | — | 默认 | API 网关：forward-auth / key-auth / 路由 |
| mysql | mysql:8.4 | 3306 | `${MYSQL_PORT:-3306}` | 始终 | 主库 `mind_base`（`app/system.sql` 初始化） |
| mongo | mongo:7 | 27017 | `${MONGO_PORT:-27017}` | 始终 | 库 `MindBase`：聊天/笔记正文/ASR/题目/板内容 |
| redis | redis:7 | 6379 | `${REDIS_PORT:-6379}` | 始终 | 缓存 L2 / 限流 / WebSocket 注册表 |
| etcd | etcd v3.5 | — | — | 默认 | APISIX 配置存储 + Milvus 元数据 |
| minio | MinIO | 9000 / 控制台 9001 | 9001 | 默认 | 云盘文件 / 壁纸 / 技能包 / 代码产物 |
| milvus | milvus v2.6 standalone | 19530 | 19530 | 默认 | 向量库：`bilibili_videos` + `cloud_drive` + `kg_entities` |
| neo4j | neo4j 5 community | 7474 / 7687 | 7474 / 7687 | 默认 | 知识图谱（`KG__URI` 指向，未连接自动降级） |
| app-task-mysql | mysql:8.4 | 3306 | 无 | 默认 | app-task 独立库 `app_task` |
| app-task | Go + Gin（`app-task/`） | 8001 | `${APP_TASK_PORT:-8001}` | 默认（task） | 定时任务调度器 + 邮件投递 + WebUI 控制台 |
| app-pay-mysql | mysql:8.4 | 3306 | `127.0.0.1:3307` | 默认（pay） | 交易库 `app_pay` |
| app-pay | Java 17 / Spring Boot 3（`app-pay/`） | 8002 | `127.0.0.1:8002` | pay | 交易/会员服务（HTTPS-only） |
| app-pay-test-mysql | mysql:8.4 | 3306 | `127.0.0.1:18306` | pay-test | 测试库 `app_pay_test`（整库隔离） |
| app-pay-test | 同 app-pay 镜像 | 8002 | `127.0.0.1:18002` | pay-test | 测试实例（强制 MOCK 渠道） |
| app-pay-admin | Go + Gin（`app-pay-admin/`） | 8003 | `127.0.0.1:8003` | pay-admin | 支付后台管理控制台（不经 APISIX） |
| app-board | Go + Gin（`app-board/`） | 8004 | 无（仅容器网络） | 默认（board） | 思维导图/白板内容存储（HTTPS-only） |
| redis-commander | — | 8081 | 8081 | tools | Redis 管理界面 |
| mongo-express | — | 8081 | 8082 | tools | Mongo 管理界面 |

profile 汇总：

| 命令 | 启动范围 |
|------|---------|
| `docker compose up -d` | 全栈（backend/frontend/nginx/apisix/全部存储/app-task/app-pay-mysql/app-board） |
| `--profile pay` | + app-pay |
| `--profile pay-test` | + app-pay-test（测试实例） |
| `--profile pay-admin` | + app-pay-admin |
| `--profile board` | app-board 已在默认 profile，此开关用于单独操作 |
| `--profile full` | 全部以上（含 tools 管理界面） |
| `--profile tools` | redis-commander / mongo-express |

另有两个独立 compose：`docker-compose.daytona.yml`（自托管 Daytona 代码沙箱，:3800）、`app-task/docker-compose.yml`（仅 app-task + 自有 MySQL，:8001；与主栈同时跑会端口冲突）。

---

## 请求路由（nginx → APISIX → 服务）

### nginx（`nginx/nginx.conf` + `locations.conf`）

- 80 / 443 两个 server 共用 `locations.conf`；443 用 `nginx/certs/` 自签开发证书（`scripts/gen-nginx-dev-cert.sh` 生成）。
- **页面路由（→ frontend）**：`/`、`/chat`、`/notes`、`/quiz`、`/favorites`、`/tasks`、`/skills`、`/billing`、`/settings`、`/blindspot` 等精确路径返回 SPA；`/wallpapers/` 静态资源。
- **双用途分发**：上述既是前端页面又是 API 前缀的路径（如 `/tasks`、`/notes`），通过 `X-Requested-With: XMLHttpRequest` 请求头区分——API 请求内部改写到 `/apisix-xhr/` 转 APISIX，页面请求转 frontend 并走缓存。
- **API 转发（→ apisix）**：`/auth` `/chat`（SSE 关缓冲）`/knowledge` `/asr` `/vec` `/notes` `/quiz` `/board/` `/task-quiz/` `/tasks` `/credentials` `/settings` `/billing` `/skills` `/cloud` `/health` `/docs` 等。
- **直连 minio**：`/minio-proxy/`（同源代理，解决 `X-Frame-Options` 对预签名 URL iframe/视频内嵌的影响）。

### APISIX（`apisix/apisix.yaml`，declarative standalone）

| 路由（前缀） | 上游 | 鉴权 |
|--------------|------|------|
| `/auth` `/chat` `/knowledge` `/notes` `/quiz` `/vec` `/asr` `/favorites` `/credentials` `/settings` `/billing` `/skills` `/blindspot` `/cloud` `/preferences` `/wallpaper` `/agent` 等 | backend:8000（SSE 路由 retries=0） | forward-auth → `X-Uid` |
| `/ws` `/ws/*` | backend:8000（WebSocket） | forward-auth |
| `/tasks` `/tasks/*`（用户端） | app-task:8001 | forward-auth → `X-Uid` |
| `/tasks/register` `/internal/task/*` `/internal/email/send` `/scripts*` | app-task:8001 | key-auth（`apikey` 头） |
| `/internal/quiz/*` | backend:8000 | key-auth |
| `/pay/*` | app-pay:8002（https） | forward-auth（回调路由 `/pay/callback/alipay` 免登录验签） |
| `/internal/pay/*` | app-pay:8002（https） | key-auth |
| `/board/*` | app-board:8004（https，挂载其 dev CA 信任锚） | forward-auth → `X-Uid`（OPTIONS 预检免鉴权） |

forward-auth 统一调 backend 的 `POST /internal/auth/verify` 校验 `Authorization: Bearer <bili_session>`，通过后向下游注入 `X-Uid`。**下游服务（app-task/app-pay/app-board）信任 `X-Uid`，不自验会话。**

---

## 数据归属（单一数据源）

| 数据 | 存储 | 说明 |
|------|------|------|
| 用户/会话/凭证（加密）/RBAC/收藏夹/视频分P/任务表 | MySQL `mind_base` | `app/models.py` 定义，`init_db()` 自动建表迁移 |
| 笔记正文/修订、聊天历史、会话总结、ASR 正文、Quiz 题目、板内容 | Mongo `MindBase` | `note_documents` / `note_revisions` / `chat_messages` / `session_summaries` / `asr_documents` / `quiz_questions` / `board_documents` 等 |
| 向量 | Milvus | 收藏视频 `bilibili_videos`、云盘 `cloud_drive`、知识图谱实体 `kg_entities` |
| 知识图谱图结构 | Neo4j | 实体/关系 + 原文证据引文 |
| 文件（云盘/壁纸/技能包/代码产物） | MinIO | 预签名 URL 经 `/minio-proxy/` 同源访问 |
| 会话缓存/限流/任务推送 | Redis | 缓存 L2；app-board 缓存用 db 2，主后端用 db 1 |
| 定时任务定义/日志/邮件队列/WebUI 账户 | MySQL `app_task` | app-task 独有，启动自建 schema |
| 订单/会员/支付事件/回调流水/SKU | MySQL `app_pay` | app-pay 独有，`schema.sql` 幂等自建；pay-admin 只读共享 |
| 思维导图/白板元数据 | MySQL `mind_base`.`board` | app-board 自有表（AutoMigrate），正文在 Mongo |
| 桌面端全部数据 | 本机 SQLite | mind-base-desktop 完全本地，不经网络后端 |

## 配置体系

主后端：分层 YAML（`default.yaml` → `config.yaml` → `local.yaml`）+ 环境变量（`段__键` 双下划线嵌套，最高优先级），详见 [configuration.md](configuration.md)。

独立服务各有自己的配置入口（均读项目根 `.env`）：

| 服务 | 配置文件 | 环境前缀 | 文档 |
|------|---------|---------|------|
| app-task | `app-task/default.yaml`（嵌入） | `APPTASK__` | [app-task.md](app-task.md) |
| app-pay | `application.yaml` + docker/test profile | `PAY_*` / `ALIPAY_*` | [app-pay.md](app-pay.md) |
| app-pay-admin | `default.yaml`（嵌入）+ config 覆盖层 | `PAYADMIN__` | [app-pay-admin.md](app-pay-admin.md) |
| app-board | `default.yaml`（嵌入） | `APPBOARD__` | [app-board.md](app-board.md) |

## 后端内部架构（app/）

```
routers/          薄路由层：参数解析 + 鉴权，不写业务
services/         业务层：rag / kg(知识图谱) / chat / notes / cloud / quiz / llm / auth /
                  blindspot(盲区) / query(改写) / doc_parser / wallpaper / preferences …
agent/            LangGraph agents：chat(默认路由) + memory / note / code / search（经 delegate）
                  + quiz(结构化出题) + summary(会话总结)；task_quiz 独立出 chat 通道
harness/          AgentHarness：ToolRegistry + Runtime + Orchestrator(LLM 路由)
                  + Lifecycle(熔断) + Scheduler(默认 bypass) + SkillManager
repository/       数据访问：MySQL / Mongo / Milvus / Neo4j 仓储
tools/            @register_tool 自发现：vector_search / kg_search / list_videos /
                  delegate_to_agent / run_code / run_skill_code / context 工具 …
infra/            配置加载 / mysql / mongo / redis / minio / neo4j / milvus / 多级缓存
```

请求链路（问答）：`router` → `services/chat` → `AgentHarness.dispatch_stream` → orchestrator 选 agent → ReAct loop（工具并发执行）→ SSE（route/chunk/step/sources/done/error）。

## CI/CD（.github/workflows）

| Workflow | 范围 | 内容 |
|----------|------|------|
| ci-backend | `app/**` | ruff lint（mypy 建议性） |
| ci-frontend | `frontendv2/**` | tsc --noEmit + ESLint + next build |
| ci-app-task / ci-pay-admin | 对应 Go 服务 | gofmt / vet / test / build |
| ci-app-pay | `app-pay/**` | mvn test（纯 JUnit，无外部 DB） |
| docker-build | push main / tag | 构建并发布 5 个镜像到 ghcr（backend/frontend/app-pay/app-pay-admin/app-task） |
| desktop-release | tag `mind-base-desktop-v*` | Tauri 桌面端构建（Windows NSIS + macOS dmg）并发布 Release |
