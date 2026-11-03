# 项目结构

> 本文说明仓库怎么组织、代码放在哪里、依赖方向与测试矩阵。
> 项目介绍见根 [README](../README.md)；系统运行形态（服务、端口、路由）见 [architecture.md](architecture.md)。

---

## 一、顶层目录

| 目录 / 文件 | 作用 |
|-------------|------|
| `frontendv2/` | 用户端 Web（Next.js 16 App Router），用户可见的全部页面 |
| `frontend-admin/` | 管理后台 SPA（Vite + React 18 + antd），分享审核 / 用户 / 审计 / 沙箱 |
| `app-ts/` | AI 域服务（Node 22 + Fastify + tsx）：chat / agent / RAG / KG AI / 向量化 / quiz AI / task-quiz / skills / 学术 |
| `app-go/` | 各领域 Go 微服务：auth / cloud / note / bili / quiz / kg / settings / admin / sandbox |
| `app-board/` | 思维导图 / 白板存储服务（Go + Gin，HTTPS-only） |
| `app-pay/` | 交易 / 会员服务（Java 21 + Spring Boot 3 + MyBatis-Plus，HTTPS-only） |
| `app-pay-admin/` | 支付运营后台（Go + Gin，服务端渲染，回环） |
| `mcp/` | MCP server（board / note / quiz 工具面），把域能力暴露给 agent |
| `apisix/` | APISIX 声明式配置（路由 / 上游 / forward-auth / key-auth / 限流） |
| `nginx/` | 统一入口（TLS、静态页、页面与接口分发、缓存） |
| `db/` | MySQL 初始化 schema（`system.sql`） |
| `deploy/` | 部署资产：`china/`（大陆镜像方案）、`docker/`（OpenSandbox 等）、`k8s/`（生产清单） |
| `proto/` | gRPC 契约（`kg/v1/kg.proto`，app-kg ↔ app-ts） |
| `scripts/` | 开发与运维脚本（证书、清理、初始化等） |
| `ops/` | Higress 自研 Wasm 插件与运维归档 |
| `skills/` | 内置技能包样例 |
| `api/` | 历史 OpenAPI 规格存档（Python 时代产物，已不代表当前服务；见 [api.md](api.md)） |
| `docs/` | 文档（索引 [docs/README.md](README.md)） |
| `docker-compose.yml` | 主 compose（默认 profile = 全栈）；另有 `docker-compose.client.yml` / `docker-compose.daytona.yml` |

---

## 二、app-ts（AI 域）

```text
app-ts/
├── config/default.yaml        # 默认配置（唯一默认值来源；密钥才进 .env）
├── prompts/                   # LLM 文案唯一家，按域子目录（目录即命名空间）
│   ├── agents/                #   agent 系统提示词（main/note/code/quiz/board/academic/...）
│   ├── chat/ quiz/ kg/        #   服务级提示词
├── test/                      # vitest 离线单测
└── src/
    ├── index.ts               # 薄启动器（bootstrap + fatal 日志）
    ├── bootstrap/container.ts # 组合根：全部 DI 装配
    ├── transport/             # 网络边界：http/routes、sse.ts、grpc.ts、internal-client.ts
    ├── services/              # 业务编排（chat / quiz / 向量化 / admission / 子 agent 服务…）
    ├── agent/                 # 编排：orchestrator / react / lifecycle / manifest + 1 主 5 子 agent
    ├── tools/                 # 工具层（按域分组，registry 注册）
    ├── rag/                   # chunk / embed / rerank / rrf / Milvus 适配
    ├── kg/                    # KG AI 编排（构建 / 抽取 / 检索）
    ├── repository/            # 契约在根，实现按 memory/ mongo/ grpc/ 归位（含 MikroORM 试点）
    ├── context/ llm/          # agent 上下文 / 网关模型工厂
    ├── transport/http/routes/ # 每域一个 controller 模块
    └── skills/ mcp/ utils/    # 技能子系统、MCP client、通用工具
````

**依赖方向**：`routes → services → harness → agent/tools → repository 契约`。具体实现只在 `bootstrap/container.ts` 选择；`transport` 不放业务语义。

---

## 三、app-go（各域权威服务）

每个服务自带 `README.md`，结构统一：

```text
app-go/app-<域>/
├── main.go                  # 入口：config → db → repo → service → router → 优雅关停
├── default.yaml             # 默认配置（通常 go:embed 进二进制）
├── Dockerfile
├── internal/
│   ├── config/ db/ logger/ metrics/
│   ├── model/ repo/ service/ router/
└── tests/                   # black-box 测试（不与源码同目录）
````

| 服务 | 领域 | 端口 |
|------|------|------|
| app-auth | 认证 / 会话 / RBAC | 8006 |
| app-cloud | 云盘 / workspaces / 配额 / 分享 | 8007 |
| app-note | 笔记 / 锚点 / 修订 / 分享 | 8008 |
| app-bili | B 站获取 / ASR / 构建编排 | 8010 |
| app-quiz | 题目存储 / 判题 / 分享 / 错题 | 8011 |
| app-kg | 知识图谱存储（gRPC + health） | 8013 / 8014 |
| app-settings | 偏好 / 壁纸 | 8015 |
| app-admin | 管理台 API（分享审核 + 沙箱代理） | 8016 |
| app-sandbox | 沙箱控制平面（租约 / 配额 / 审计 / 产物 / 准入） | 8017 |

---

## 四、前端

```text
frontendv2/
├── app/                    # Next.js App Router（chat / research / favorites / notes / mindmap /
│                           #   cloud-drive / quiz / task-quiz / graph / blindspot / skills / membership …）
├── components/             # 按功能域组织的 UI 组件
├── lib/api/                # 唯一 API 调用入口（按域分模块，组件禁止直接 fetch）
├── lib/chat-stream.ts      # SSE 流解析
├── lib/nav-config.ts       # 顶部导航配置（主栏 / 更多 / 账户）
└── app/globals.css         # Tailwind v4 主题 tokens

frontend-admin/             # 独立 SPA，不复用 frontendv2 代码
├── src/api/                # 唯一请求层（client.ts + 域模块）
├── src/pages/              # Login / Shares / Users / Audit / Sandbox
└── src/components/         # 布局 / 改密 / 格式化工具
````

**前端红线**：所有请求经 `lib/api/`（或管理台 `src/api/`）；不在组件内直接 `fetch`；不猜测 / 伪造 session id；不缓存替代后端数据源。

---

## 五、依赖方向与边界

| 层 / 组件 | 规则 |
|-----------|------|
| 前端 | 组件 → `lib/api/` → HTTP；不回传 / 不透传 cookie |
| app-ts | `transport/http/routes` → `services` → `harness` → `agent/tools` → `repository` 契约 |
| app-ts 数据层 | Mongo / gRPC 客户端只在 `repository/mongo/`、`repository/grpc/` 实现与组合根出现，禁止 import 进 services / routes / agent |
| Go 服务 | `router → service → repo`；router 只做参数解析 + 鉴权 + 调用 |
| 管理台 | app-admin 只读用户 / 分享元数据 + 写审核列 + 代理沙箱管理；不下载、不导出文件内容 |
| 网关 | APISIX 无 catch_all：新增端点必须显式加路由（`apisix/apisix.yaml` 与 `apisix.dev.yaml`） |
| 数据归属 | 每个域唯一写者；跨服务只读须在注释中标明（见 [architecture.md](architecture.md)） |

---

## 六、新增代码落位

| 需求 | 位置 |
|------|------|
| app-ts 新增 HTTP 端点 | `src/transport/http/routes/<域>.ts` + `server.ts` 注册 + APISIX 路由 |
| 新增数据仓储 | `src/repository/<域>.ts` 契约 → `memory/` → `mongo/`（或 MikroORM）→ 组合根装配 |
| 新增 / 调整 agent | `src/agent/manifest.ts`（名称 + 描述唯一来源）+ `agent/<名>/agent.ts` |
| 新增 agent 工具 | `src/tools/<域>/` 工厂 + 组合根注册 |
| 新增 / 调整提示词 | `prompts/<域>/<名>.md`（命名空间 = 相对路径去 `.md`） |
| 新增前端页面 | `frontendv2/app/<route>/page.tsx` + `components/<域>/` + `lib/api/<域>.ts` + `nav-config.ts` |
| 新增 Go 服务 | 按 `app-go/app-<域>/` 骨架（config / db / repo / service / router / tests）+ compose + APISIX 上游 |
| 新增配置项 | 服务 `default.yaml` + 配置类型；仅密钥才进 `.env.example` 与 `docs/configuration.md` |

---

## 七、测试矩阵

| 范围 | 命令 | 说明 |
|------|------|------|
| app-ts | `npm run typecheck`、`npm test` | vitest 离线；Mongo / Milvus 用例无实例自动 skip |
| Go 服务 | `go test ./...` | 各 `app-go/app-*` 与 `app-board` / `app-pay-admin` / `mcp/*` |
| app-sandbox | `go test ./...`（`tests/` 目录） | black-box；MySQL 用例需 `SANDBOX__TEST_DSN` |
| app-pay | `mvn test` | 纯 JUnit，无外部 DB |
| frontendv2 | `npm run lint`、`npx tsc --noEmit`、`next build` | CI `ci-frontend` |
| frontend-admin | `pnpm build` | tsc --noEmit + vite build |

CI 工作流在 `.github/workflows/`：按目录分服务触发，`docker-build` 在 push main / tag 时构建镜像。桌面端（独立仓库）的 CI 与 Release 在该仓库内维护。

---

## 八、提交约定

- 提交信息：`[模块] type: 说明`（模块如 chat / rag / frontend / board / pay / agent / docs）。
- 不提交：`.env`、数据库数据、密钥、构建产物、本地日志。
- 普通配置走各服务 YAML；只有密钥 / 连接串进 `.env` 与 `.env.example`。
- 新增 / 删除服务时同步：`docker-compose.yml`、APISIX 路由、nginx 分发、`docs/architecture.md`、`docs/configuration.md`。

---

## 相关文档

- [README](../README.md) —— 项目介绍
- [architecture.md](architecture.md) —— 服务清单、端口、路由、数据归属
- [getting-started.md](getting-started.md) —— 本地开发环境
- [configuration.md](configuration.md) —— 配置与密钥
- [api.md](api.md) —— API 面与鉴权
