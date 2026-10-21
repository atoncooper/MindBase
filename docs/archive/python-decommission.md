# Python backend（`app/`）下线计划

> **决策（用户）**：废弃 `app/`，后续能力一律落 app-ts（Node/Fastify）或 app-go（Go）。本文件是这次 decommission 的**唯一待办清单**：每迁完一项就勾掉，全部勾完后才允许改 compose / APISIX 删除 backend。
>
> 状态：**✅ 已完成（2026-10-06）**。P0-P6 全部执行完毕：全域切流 + compose/Dockerfile/APISIX 手术完成 + `app/` 代码树删除（schema 迁 `db/system.sql`；完整历史可从 git tag/commit b2edb5d 找回）。APISIX 双 yaml 已无任何 backend upstream/路由/catch_all 兜底——**新端点必须显式加路由**。
>
> 部署冒烟清单（compose 起栈后逐页验证）**尚未执行**，见 §8。

---

## 1. 完成定义（DoD）

backend 可以被删除，当且仅当以下全部成立：

1. ✅ APISIX（`apisix.yaml` + `apisix.dev.yaml`）中不存在任何指向 `upstream-backend / -sse / -ws` 的路由，`catch_all` 已删除（未列举路径一律 404）。
2. ✅ `docker-compose.yml` 已删 `backend` 服务与 `backend_data`/`backend_logs` 卷，四处 `depends_on: backend` 全部摘除。
3. ✅ `nginx/` 无 `$backend_upstream` 残留（map 已删）。
4. ✅ 前端 `frontendv2/lib/api/**` 已无任何仅 Python 实现的端点（2026-10-07 清理：删 `code-executions.ts`/`settings.ts`/`chatApi.ask|search`/`knowledgeApi.getVideoPages` 死面；域→服务映射见 `frontendv2/lib/api/README.md`）。
5. ✅ 已完成（2026-10-06）：`ci-backend.yml`、根 `Dockerfile`、`ruff.toml`、`requirements.txt` 已删；`app/` 树整体删除（schema 迁 `db/system.sql`）。
6. ✅ `docs/architecture.md`（2026-10-07 重写为多服务版）、`AGENTS.md`、`docs/*-migration.md` 的架构描述与路由表已同步更新。

---

## 2. 已完成迁移（勿重复劳动）

| 面 | 归宿 | 文档 |
|---|---|---|
| 认证 / 会话 / 账户 | `app-go/app-auth`（:8006，APISIX forward-auth 权威） | AGENTS.md §2.13 |
| 云盘（配额/分享/回收站/解析向量化） | `app-go/app-cloud`（:8007） | AGENTS.md §2.14 |
| 笔记 CRUD/锚点/修订/分享 | `app-go/app-note`（:8008）+ `mcp/app-note-mcp` | [app-note-migration.md](app-note-migration.md) |
| B 站获取 / ASR / build 编排 | `app-go/app-bili`（:8010） | [app-bili-migration.md](app-bili-migration.md) |
| quiz 存储（历史/错题/导出/分享） | `app-go/app-quiz`（:8011）+ `mcp/app-quiz-mcp` | [app-quiz-migration.md](app-quiz-migration.md) |
| 用户 embedding/ASR 配置 | `app-go/app-settings`（:8015） | AGENTS.md §2.19 |
| KG 存储（Neo4j + kg 记账） | `app-go/app-kg`（gRPC :8013） | [app-kg.md](app-kg.md) |
| chat ask/stream、sessions、history、agent、RAG | `app-ts`（:8000，沿用退役 Python backend 的端口） | [app-ts-cutover.md](app-ts-cutover.md) |
| 思维导图 AI 补全 `/chat/board/complete` | `app-ts`（`src/services/board-completion.ts` + `src/transport/http/routes/board.ts`） | 本文档 §3.B |
| 会话总结 `/chat/sessions/{id}/summary`（SSE + latest） | `app-ts`（`src/services/session-summary.ts` + `src/transport/http/routes/session-summary.ts` + `prompts/summary.md` + Mongo `mind_base_ts.session_summaries`） | 本文档 §3.B |
| BYOK LLM 凭证 `/credentials*`（CRUD + default + test） | 曾迁 app-settings；**2026-10-07 BYOK 整体退役**——用户不再自带 API Key，`/credentials` 与 `/settings/*-configs` 前后端连同网关路由删除（详见 AGENTS.md §2.19） | 本文档 §3.D |
| 定时出题业务 `/tasks/{id}/detail`、`/tasks/{id}/answer` | `app-quiz`（`internal/repo/task_quiz*.go` + `internal/service/task_quiz.go` + `internal/router/task_quiz.go`；`quiz_task`/`quiz_task_answer` 表 + Mongo `task_quiz_questions`） | 本文档 §3.C |
| 会话总结出题 `/quiz/generate-from-summary` | `app-ts`（`src/services/quiz-generation.ts` + `app-quiz-client.ts` + `routes/quiz.ts`），存储经 app-quiz `/internal/quiz/*` | 本文档 §3.C |
| 视频出题 `/quiz/generate`（folder_ids / pages） | `app-ts`（同上 + `RAGService` 检索 + app-kg `ResolveScope`；APISIX `quiz_ai_generate` priority 110） | 本文档 §3.C |
| quiz 批改 `/quiz/submit` | `app-ts`（`src/services/quiz-grading.ts`；APISIX `quiz_ai` priority 100） | 本文档 §3.B |
| 定时出题 LLM 编排 `/internal/quiz/generate-llm` + `/status` | `app-ts`（`services/task-quiz-generation.ts`；app-task 执行器回调经 APISIX key-auth；Mongo `task_quiz_questions` 共享集合） | 本文档 §3.C |
| task-quiz agent `/task-quiz/chat`、`/task-quiz/register` | `app-ts`（独立小 agent：streamText + random_time_generator/submit_task/query_task；register 经 app-auth `/internal/auth/user/{uid}` 查 email → app-task） | 本文档 §3.C |
| 盲区图 `/blindspot/{map,entity/:eid,:eid/quiz}` | `app-ts`（`services/blindspot.ts`：exposure/evidence 走 app-kg gRPC、signals 走 app-quiz `/internal/quiz/quiz-signals`、scope 走 app-bili internal） | 本文档 §3.C |
| 技能 `/skills/*`（7 端点，存储重设计） | `app-ts`（zip 存 MinIO + 元数据 Mongo `mind_base_ts.skills_meta`；**旧 Python installed_skills 数据不迁移，需重装**；`load_skill` 工具 + SKILLS_SECTION 注入 main agent） | 本文档 §3.D |
| 工作区 `/workspaces*` | `app-cloud`（`internal/router/workspace.go`；camelCase wire 复刻 Python by_alias；ExpandAndRecalc 绑定展开） | 本文档 §3.E |
| 偏好 `/preferences` + 壁纸 `/wallpaper/*` | `app-settings`（KV JSON 偏好 + MinIO 壁纸门面，空 endpoint=503 fail-safe） | 本文档 §3.E |

---

## 3. 残余 Python 面清单（✅ 已全部清零）

图例：**消费** = 前端是否有活的 API 模块/页面；**目标** = 应该迁到哪；**量** = Python 侧实现体量参考。

> **2026-10-06 收口**：本节每一行都已有归宿——迁移（§3.A-C）或确认为死面直接删除（§3.E）。下文保留原始分析过程作存档，各行的最终处理以 §2 完成表与本节批注为准。

### A. app-ts 已实现，只缺 APISIX 接线（零代码）

| 端点 | 消费 | 目标 | 备注 |
|---|---|---|---|
| `/knowledge/kg/{build,active,status/:id,stats,subgraph}` | `frontendv2/lib/api/kg.ts` | app-ts `routes/kg.ts` | ✅ **已切流**（APISIX `kg_ts` 路由；Python `DELETE /knowledge/video/{bvid}` 直删 Neo4j 语义由 app-ts `KgService.deleteVideoData` 承接） |
| `/agent/runtime`、`/agent/models` | 无前端消费（运维/调试） | app-ts `routes/system.ts` | app-ts 已实现同名端点 |
| `/health` | compose healthcheck | 各服务自有 | 删除 backend 时同步改 healthcheck 引用 |

### B. app-ts 需补 HTTP 面（agent / service 已存在）

| 端点 | 消费 | 目标 | 量 / 备注 |
|---|---|---|---|
| `/chat/board/complete` | `lib/api/boards.ts` | ✅ **本轮已完成**（已加入 APISIX `chat_ts`） | — |
| `/session-summary/*` | `lib/api/session-summary.ts` | ✅ **已完成**（`SessionSummaryService`：prepare 前置校验 404/400、chunk/done/error SSE、落库 `mind_base_ts.session_summaries`）。注意该路径早已被 APISIX `chat_ts` 的 `/chat/sessions/*` 覆盖到 app-ts，所以此前是 404 坏面，本次为修复 |
| `/quiz/generate`、`/quiz/generate-from-summary`、`/quiz/submit` | `lib/api/quiz.ts` | ✅ **全部已迁 app-ts**（generate/generate-from-summary 见 §4 P2；submit 批改 = `quiz-grading.ts` + app-quiz `/internal/quiz/grading` 落库） |

### C. 需完整迁移到 app-ts（含数据/存储/编排）

| 端点 | 消费 | 目标 | 量 / 备注 |
|---|---|---|---|
| `/vec/page/{create,status,status/:taskId,revector}` | `lib/api/vec-page.ts` | ✅ **已迁 app-ts**（账本 = Mongo `mind_base_ts.vec_pages`/`vec_tasks`；`bili:page_ready` 消费者 = app-ts `BiliEventBridge`；MySQL `video.is_vectorized*` 陈旧不再消费） | Python `services/vector_page_service.py` 21KB 语义逐条复刻 |
| `/knowledge/stats`、`/knowledge/clear`、`/knowledge/video/{bvid}`、`/knowledge/folders/status`、`/knowledge/pages/vectorized` | `lib/api/knowledge.ts` | ✅ **已迁 app-ts**（APISIX `vec_knowledge_ts` priority 55；admin 旁路读 X-Roles；deprecated `/knowledge/video/{bvid}/pages` 未迁，直接弃） | 与 vec 管线同批 |
| `/blindspot/map`、`/blindspot/entity/{eid}`、`/blindspot/{eid}/quiz` | `lib/api/blindspot.ts` + `/blindspot` 页 | ✅ **已迁 app-ts**（exposure/evidence 走 app-kg gRPC；quiz signals 走 app-quiz `/internal/quiz/quiz-signals`；probed = app-ts 自己的 chat_messages；实体向量在 `mind_base_ts.kg_entities`） | |
| `/task-quiz/chat`、`/task-quiz/register` | `lib/api/task-quiz.ts` + `/task-quiz` 页（主导航） | ✅ **已迁 app-ts**（独立小 agent：streamText + 3 工具，简单帧协议 chunk\|tool\|done\|error；register 经 app-auth 查 email → app-task） | |
| `/internal/quiz/generate-llm`、`/internal/quiz/status/*` | app-task（key-auth） | ✅ **已迁 app-ts**（QUIZ_EXECUTOR_URL 现指 APISIX → app-ts；quiz_task 行经 app-quiz `/internal/quiz/tasks` + `/tasks/:id/generated`） | |
| `/internal/ai-usage`（Higress usage-logger Wasm 上报端） | Higress 插件（fire-and-forget） | ⚠️ **未迁（已知遗留）**：app-ts 未实现该端点，插件上报会失败但不影响主链路；插件配置在 Higress 控制台（`backendHost` 仍指已退役的 backend）。网关侧计量暂以 Higress ai-statistics/Console 为准；需要入库时在 app-ts 补 `/internal/ai-usage` 并改插件指向 | |

### D. 归属数据面（存储重设计）

| 端点 | 消费 | 目标 | 量 / 备注 |
|---|---|---|---|
| `/skills/*`（installed/install/delete/store list/store install/store contents/preview） | `lib/api/skills.ts` + `/skills` 页 | ✅ **已迁 app-ts（存储重设计，非 app-go）**：zip 在 MinIO（`src/skills/minio-store.ts`）+ 元数据 Mongo `mind_base_ts.skills_meta`（不再用 Python MySQL `installed_skills`，**旧数据不迁移需重装**）；jszip 解析复刻 zip_parser；`load_skill` 工具 uid 取自 ToolRunContext；main agent system prompt 注入 SKILLS_SECTION | |

### E. 死面（无消费方，删除即可，不需要迁移）

> 注：`/workspaces*`、`/preferences`、`/wallpaper/*` 虽属死面（前端无组件消费），最终仍随数据面一并迁出（workspace→app-cloud、preferences/wallpaper→app-settings），后端有实现、前端模块保留备用。其余死面已删除。

| 端点 | 依据 |
|---|---|
| `/billing` | 前端页面与 API 模块已删（`nav-config.ts` 注释） |
| `/tasks`（监控列表） | 同上 |
| `/chat/ask`（非流式）、`/chat/ask/agentic` | 前端仅用 `/chat/ask/agent/stream`（[app-ts-cutover.md](app-ts-cutover.md) §取舍） |
| `POST /chat/search` | 前端 `chatApi.search` **无任何组件调用**（grep 全仓 0 命中） |
| `/chat/messages/{id}/code-executions`(+ `/{execId}`) | `lib/api/code-executions.ts` 仅被 `index.ts` 导出，**无组件调用** |
| `/preferences`（GET/PATCH） | `preferencesApi` 全仓无组件调用（仅自身定义） |
| `/wallpaper/{presets,preset,upload,file/*}` | `wallpaperApi` 全仓无组件调用 |
| `/workspaces*`（列表/建改删/bindings/files） | `workspaceApi` 全仓无组件调用（组件里的 workspace_pages 是前端自构造，不走该 API） |
| `/ws`、`/ws/*`（任务通知 WebSocket） | ✅ 已删（2026-10-06）：frontendv2 无 WS 消费方；`ws_notifications` 路由 + `upstream-backend-ws` + nginx `/ws` location + Python WS 栈全部移除 |
| `/docs`、`/openapi.json` | 仅 Python 自带调试面 |
| `/settings/credentials*` | app-settings 已明确不实现（404）；前端 `lib/api/settings.ts` 仍在调，属已坏面，随前端清理一并删 |
| `/internal/auth/verify`（Python 实现） | 权威已是 app-auth；Python 版仅作应急回退，删除即可（✅ dev `apisix.dev.yaml` 13 处 forward-auth 已改指 `192.168.138.1:8006` 并补 `auth_user` 路由） |

---

## 4. 建议执行顺序（✅ 全部完成）

- ✅ **P0 接线**：`/knowledge/kg/*` 切 app-ts（`kg_ts`）；`apisix.dev.yaml` forward-auth 改指 app-auth + 新增 `upstream-app-auth`/`auth_user`；死面确认无需迁移（见 §3.E）。
- ✅ **P1**：`/chat/board/complete`、`/session-summary/*` 迁 app-ts。
- ✅ **P2 quiz 域**：`/tasks/{id}/detail` + `/tasks/{id}/answer` 迁 app-quiz；app-quiz `/internal/quiz/*` 扩富 schema 生命周期（`POST /internal/quiz/sets`（可建 generating 集）、`/sets/:uuid/questions`（落题 finalize）、`/sets/:uuid/fail`）+ `/internal/quiz/quota/{peek,consume}`（Redis 每日配额，与 Python 同键）；`/quiz/generate-from-summary`、`/quiz/generate`、`/quiz/submit` 全部迁 app-ts（`quiz_ai_summary`/`quiz_ai_generate` priority 110、`quiz_ai` priority 100）；`/internal/quiz/generate-llm|status` 迁 app-ts（app-task 执行器回调）。
- ✅ **P3 向量/知识域**：`/vec/page/*` + `/knowledge/*` 残余 + `/blindspot/*` 迁 app-ts（账本迁 Mongo vec_pages/vec_tasks；`bili:page_ready` 消费者 = app-ts `BiliEventBridge`；APISIX `vec_knowledge_ts` priority 55；app-bili 新增 `/internal/bili/{scope,owns}` 供数）。
- ✅ **P4 数据面**：`/credentials` 迁 app-settings；`/skills/*` 迁 app-ts（存储重设计）；`/workspaces*` 迁 app-cloud；`/preferences` + `/wallpaper/*` 迁 app-settings。
- ✅ **P5 task-quiz agent**：`/task-quiz/*` 迁 app-ts（chat 独立小 agent + register 代理）。
- ✅ **P6 收尾**：compose 删 backend 服务/卷/depends_on；APISIX 删三个 backend upstream + catch_all（`/chat/search` 归 `vec_knowledge_ts`）；nginx 删 `$backend_upstream` map 与 `/ws` location；删 `ci-backend.yml`/根 `Dockerfile`/`requirements.txt`/`ruff.toml`/`app/` 代码树（schema 迁 `db/system.sql`）；`/ws` WebSocket 整链删除（frontendv2 无 WS 消费方，任务进度靠轮询）。

---

## 5. 收尾改动清单（✅ P6 已执行）

### docker-compose.yml
- ✅ 删除 `backend` 服务与 `backend_data` / `backend_logs` 卷。
- ✅ 摘除四处 `depends_on: backend`（frontend/nginx/apisix/app-task）。
- ✅ 保留仍被 app-ts / app-go 使用的共享 env（`RDBMS__URL`、`MONGO__URI`、`AI_GATEWAY__*`、`SECURITY__API_KEY_ENCRYPTION_KEY` 等）。

### apisix/apisix.yaml + apisix.dev.yaml
- ✅ 删除 `upstream-backend` / `upstream-backend-sse` / `upstream-backend-ws` 与全部指向路由（`task_quiz_chat` 等已改指 app-ts，`quiz_ai*`/`tasks_detail`/`tasks_answer` 改指 app-ts/app-quiz，`ws_notifications` 随 WS 链删除）。
- ✅ `catch_all` 删除（`/chat/search` 归 `vec_knowledge_ts`）；未列举路径一律 404。
- ✅ dev yaml forward-auth 全部改指 app-auth。

### nginx
- ✅ 删除 `map $request_uri $backend_upstream`；更新 `/cloud/` 相关注释；删除 `/ws` location。

### 其他
- ⚠️ `ops/wasm-plugins/usage-logger` 默认 `backendHost: backend` 已失效（插件配置在 Higress 控制台；app-ts 未实现 `/internal/ai-usage`，见 §3.C 遗留项）。
- ✅ 已删（2026-10-06）：`ci-backend.yml`、根 `Dockerfile`、`requirements.txt`、`ruff.toml`、`app/` 代码树。
- ✅ `AGENTS.md`、`docs/architecture.md`（2026-10-07 重写）、`frontendv2/lib/api/README.md`（2026-10-07 新增）路由表与架构图已同步。

---

## 6. 验收

1. `docker compose config` 通过，无 backend 引用。
2. 全栈起栈后，前端主流程（登录 / 对话 / 收藏夹 / 笔记 / 云盘 / 思维导图 / 题目练习 / 定时出题 / 知识图谱 / 知识盲区 / 技能商店 / 设置 / 会员）逐页无 502/404。
3. `grep -rn "upstream-backend\|:8000" apisix/ nginx/ docker-compose.yml` 无命中（除注释与 app-ts 自身端口说明）。
4. `git grep -l "app/routers\|app/services"` 仅剩已明确保留的回滚代码或已删除。

---

## 7. 回滚

逐项独立回滚：P0-P5 每项改动 = 一条 APISIX 路由改指 + 对应服务代码；P6 的一次性删除依赖前面全部完成，若出问题用 `git revert` 恢复 compose/APISIX 即可（Python 代码在删除前一直保留在仓库）。

> ⚠️ **P6 已执行后，Python 回滚路径不复存在**：`app/` 代码树已删除，回滚只能 `git revert` 整个退役提交序列。

## 8. 部署冒烟清单（⚠️ 未执行）

compose 起全栈后逐项验证（对应 2026-10-06 切流域）：

1. **task-quiz 全链**：注册任务 → 到点生成（app-task → app-ts `/internal/quiz/generate-llm`）→ 邮件 → 用户作答（`/tasks/{id}/answer` 判题）。
2. **盲区图**：`/blindspot` 页出图（需先有 KG 数据）；实体出题链路。
3. **技能**：上传安装 / 商店安装 / 对话中 `load_skill` 生效（SKILLS_SECTION 注入）。
4. **壁纸/偏好**：上传自定义壁纸、预设切换、`/preferences` KV 读写。
5. **收藏夹→向量**：新收藏夹同步 → ASR → `bili:page_ready` → app-ts 自动向量化 → 检索可见。
6. **工作区**：绑定云盘文件/收藏夹分P 后检索过滤生效（`workspace_pages`）。
7. **主流程逐页无 502/404**：登录/对话/收藏夹/笔记/云盘/思维导图/题目练习/知识图谱/知识盲区/技能商店/设置/会员。
8. `grep -rn "upstream-backend\|:8000" apisix/ nginx/ docker-compose.yml` 无命中（除注释与 app-ts 自身端口说明）。

## 2026-10-06 后续清理

- `app/` Python 代码树整体删除；MySQL 初始化 schema 迁 `db/system.sql`（compose ×2 + deploy/china + deploy/k8s 挂载同步；完整历史可从 git commit b2edb5d 找回）。
- `/cloud/documents*`（app-ts 未接线的云盘文档摄取面，4 端点）删除：前端零调用、`/cloud/*` 网关与 nginx 全部指向 app-go/app-cloud（自带 Higress 向量化管线）；连带删除 `services/cloud-documents.ts` + `repository/cloud-files*` 三层与对应测试。
- `/agent/runtime`、`/agent/models` 保留：运维/调试面，frontend-admin 首页规划消费。
- `/chat/documents` 保留：前端尚无上传 UI，但 session-docs 检索侧已接线进 main agent 上下文。
