# MindBase 知识库

MindBase 是一个个人知识库 RAG 系统，把 B 站收藏和云盘文档转化为可检索、可问答、可复习的知识。

核心链路：同步 B 站收藏夹 → ASR 语音转文字 → 文本向量化（embedding）→ 写入 Milvus → ReAct Agent 流式问答（来源追踪）。可选知识图谱：LLM 从转写稿抽取实体与关系写入 Neo4j（带原文引文防幻觉），问答时支持跨视频实体关联检索。

除问答外，AI 还能自动生成 Markdown 笔记（Note Agent）、在 Daytona 沙箱运行代码（Code Agent）、按内容出题练习（Quiz）、定时出题邮件提醒（app-task，Go 独立服务）、编辑思维导图与白板（app-board，Go 独立服务）。可选会员支付（app-pay，Java 独立服务）与支付后台管理（app-pay-admin，Go）。另有一个完全本地的桌面端（mind-base-desktop，Tauri 2，无后端依赖）。前端采用 Apple 风格界面：顶部导航栏承载功能，黑白极简，壁纸背景（静态/动态 mp4）。

后端 FastAPI + LangGraph multi-agent（Chat / Memory / Note / Code / Search / Summary 六个 harness 注册 agent，Quiz 为结构化出题模块，task-quiz 独立对话通道；子 agent 经 delegate 按需调用）。存储：MySQL + Milvus + MongoDB + Redis + MinIO + Neo4j（可选，知识图谱）+ Daytona（可选）。前端 Next.js 16。支持 OpenAI / DashScope / DeepSeek 多 LLM Provider。

适合「收藏了很多但没时间整理」的学习者，把碎片化收藏变成可用的知识库。

---

## 部署与启动

详细的本地开发与生产部署步骤已拆到 `docs/`（README 只保留入口与最简命令，避免与 docs 重复漂移）。按场景选文档：

| 场景 | 文档 |
|------|------|
| **直接用 Docker 本地跑起来（⭐ 普通用户入口：装 Docker → 拉代码 → 申请 API Key → 配 .env → 启动 → 验证 → 开始用）** | [`docs/setup-guide.md`](docs/setup-guide.md) |
| **系统架构总览**（服务清单/端口、nginx→APISIX 路由、数据归属、CI） | [`docs/architecture.md`](docs/architecture.md) |
| **本地开发**（前置 → 克隆/依赖 → 配 .env → 起后端/前端 → 验证全链路） | [`docs/getting-started.md`](docs/getting-started.md) |
| **环境变量 / 配置参考**（完整变量表、YAML 分层加载、密钥） | [`docs/configuration.md`](docs/configuration.md) |
| **Docker 生产部署**（一键启动、profiles、HTTPS、监控、备份） | [`docs/deployment.md`](docs/deployment.md) |
| **中国大陆镜像部署**（`ghcr.io`/`gcr.io`/`quay.io` 被墙时的替代方案） | [`deploy/china/README.md`](deploy/china/README.md) |
| **定时出题任务 app-task**（功能 / 独立启动 / WebUI 登录 / 配置） | [`docs/app-task.md`](docs/app-task.md) |
| **思维导图/白板服务 app-board**（API / 乐观锁 / TLS / 配置） | [`docs/app-board.md`](docs/app-board.md) |
| **交易/会员服务 app-pay**（订单状态机 / 渠道 / 审计 / 配置） | [`docs/app-pay.md`](docs/app-pay.md) |
| **支付后台 app-pay-admin**（查询 / 补偿开通 / 鉴权） | [`docs/app-pay-admin.md`](docs/app-pay-admin.md) |
| **桌面端 mind-base-desktop**（Tauri 2，全本地） | [`docs/mind-base-desktop.md`](docs/mind-base-desktop.md) |

### 最简命令（TL;DR）

```bash
# 本地开发
uvicorn app.main:app --reload --port 8000    # 终端 1：后端 → http://localhost:8000/docs
cd frontendv2 && npm run dev                  # 终端 2：前端 → http://localhost:3000

# Docker 部署（默认 profile = 全栈，含 Milvus/Neo4j/APISIX/nginx/app-task/app-board）
cp .env.example .env                          # 至少填 LLM__API_KEY、SESSION__SECRET、
                                              # SECURITY__API_KEY_ENCRYPTION_KEY、APISIX_CONSUMER_KEY
docker compose up -d --build                  # 入口 http://localhost:3000（nginx 80/443 亦可）

# 定时出题（默认 profile 已含 app-task；WebUI 控制台 http://localhost:8001/
# 登录 admin / app-task-admin，生产务必改密）
# 也可只跑 app-task：cd app-task && docker compose up -d --build
```

> ⚠️ 环境变量、profile 服务范围、HTTPS/TLS、故障排查、Daytona 代码沙箱等细节请在对应的 docs/ 文档中查阅，README 不再重复维护。

---

## 功能模块

### 对话（Agentic Chat）

- **入口**：导航栏 `对话`
- **Agent**：Chat（默认路由）+ Memory / Note / Code / Search（经 `delegate_to_agent` 调用）+ Summary（会话总结，按钮触发）
- **流式 SSE**：route / chunk / step / sources / done / error 六种事件（`lib/chat-stream.ts` 解析）
- **工具**：vector_search / kg_search（知识图谱实体关联检索，Neo4j 可用时注册）/ list_videos / get_video_summaries / run_code（Daytona）/ run_skill_code / delegate_to_agent 等
- 上下文自动压缩：token 预算触发的会话摘要，控制长对话成本

### 收藏夹

- **入口**：导航栏 `收藏夹`
- 同步 B 站收藏夹与视频列表，分 P 查看、ASR 内容、向量化状态
- **知识图谱面板**：一键从视频转写稿抽取实体与关系写入 Neo4j（幂等，内容未变自动跳过），展示实体 / 关系 / 证据 / 覆盖视频统计与构建进度；未连接 Neo4j 时自动降级为不可用态

### 知识图谱（kg_search）与盲区图

- **图谱**：构建链路 = 收藏夹 → 已转写分P → LLM 结构化抽取（每条关系必须携带原文引文）→ 校验防幻觉边 → 写 Neo4j + 实体向量进 Milvus；查询链路 = 实体链接 → 子图多跳扩展 → 证据回捞（按用户收藏范围过滤）。前端 `/graph` 提供力导向可视化
- **盲区图**（`/blindspot`）：基于图谱与答题数据定位知识盲区实体，支持对盲区一键出题

### 思维导图 / 白板（app-board）

- **入口**：导航栏 `思维导图`（`/mindmap`）
- Drive 风格板列表 + 完整编辑器（simple-mind-map，从桌面端移植）；800ms 防抖自动保存 + Ctrl+S
- 存储：独立 Go 服务 app-board（MySQL 元数据 + Mongo 正文，`If-Match` 乐观并发锁）；白板（Excalidraw）存储契约就绪，编辑器 P3 接入
- 详见 [`docs/app-board.md`](docs/app-board.md)

### 云盘

- **入口**：导航栏 `云盘`
- 文件夹树、上传（分片直传 MinIO）、搜索、排序、批量处理
- WebSocket 实时推送处理状态（ASR / 向量化）
- 云盘文档一键转笔记（note agent 整理）、文档全文提取（pdf/docx/doc/html/md/txt）

### 题目练习

- **入口**：导航栏 `题目练习`
- 按收藏夹/分 P/会话总结出题（LLM 结构化输出），提交批改、历史回看
- 错题本 + 训练数据导出（JSONL / CSV / SFT）

### 定时出题（app-task）

- **入口**：`/task-quiz`（对话定义任务）+ `/tasks`（任务列表/答题）
- 用户与 AI 对话定义"到某时间出一道题"，AI 按北京时间随机生成触发时间（避开睡觉/午休）
- 到点自动 LLM 生成题目，HTML 邮件发给用户+抄送人，限时答题；超时未答发"未完成语录"提醒
- 独立 Go 调度服务（自写 DB 轮询 scheduler + 邮件投递队列 + WebUI 控制台），详见 [`docs/app-task.md`](docs/app-task.md)

### 技能（Skills）

- **入口**：导航栏 `技能`
- 技能包安装/卸载（MinIO 存储），技能商店（GitHub topic `mindbase-skill`，默认关）
- `run_skill_code` 在 Daytona 沙箱执行技能代码（`DAYTONA__ENABLED` 闸门）

### 笔记

- **入口**：导航栏 `笔记`
- Markdown 编辑器、锚点定位、修订历史、公开分享（免登录只读，服务端二次消毒）
- 详见 [`docs/notes.md`](docs/notes.md)

### 会员 / 支付（可选服务）

- app-pay（Java Spring Boot）：SKU / 订单 / 支付宝当面付（沙箱）/ 会员态，全链路 HTTPS + 资金审计
- app-pay-admin（Go）：只读运营查询 + 会员补偿开通（`http://127.0.0.1:8003`，默认 `admin` / `app-pay-admin`）
- 详见 [`docs/app-pay.md`](docs/app-pay.md) / [`docs/app-pay-admin.md`](docs/app-pay-admin.md)

### API 设置 / 个人中心

- **入口**：导航栏 `API 设置` / `个人中心`
- LLM / Embedding / ASR 多 Provider 凭证管理，默认凭证、连接测试
- 个人资料、安全绑定（B 站/邮箱/密码/微信）、退出登录
- 登录方式：B 站扫码、账号密码（图形验证码）、邮箱注册、手机短信、微信扫码（各自有配置开关，未启用自动隐藏）

### 桌面端（mind-base-desktop）

- Tauri 2 全本地应用（Windows/macOS）：聊天 agent、B 站知识库、混合检索、思维导图/白板、Quiz、笔记、简历/幻灯片 agent、学术研究 agent + 记忆架构
- 与 Web 后端无运行时依赖，数据全在本机 SQLite
- 详见 [`docs/mind-base-desktop.md`](docs/mind-base-desktop.md)

---

## API 概览

| 模块 | 前缀 | 主要端点 |
|------|------|---------|
| 认证 | `/auth` | 扫码登录（B站/微信）/ 密码/邮箱/手机登录 / token 管理 / 验证码 |
| 收藏夹 | `/favorites/v2` | 列表 / 同步 / 视频 / 分P 元数据 |
| 知识库 | `/knowledge` | 构建 / 状态 / 清空 / 知识图谱 kg（build / active / status / stats / subgraph） |
| 盲区 | `/blindspot` | 盲区图 / 实体详情 / 盲区出题 |
| 聊天 | `/chat` | ask/agent/stream（SSE）/ sessions / history / 会话总结 |
| ASR | `/asr` | create / update / reasr / versions |
| 向量化 | `/vec/page` | create / revector / status |
| 笔记 | `/notes` | CRUD / anchors / revisions / share / convert-from-cloud |
| 思维导图 | `/board` | boards CRUD（If-Match 乐观锁）/ pin |
| 题目 | `/quiz` | generate / generate-from-summary / submit / history / export / share |
| 定时出题 | `/task-quiz` `/tasks` | chat（定义任务）/ register / answer / 列表 |
| 云盘 | `/cloud` | 分片上传 / folders / files / 处理状态 / raw 预览 |
| 凭证 | `/credentials` `/settings` | 多 Provider API Key CRUD / embedding / asr 配置 |
| 计费 | `/billing` | 用量统计 / by-provider / by-credential / timeseries |
| 技能 | `/skills` | installed / install / uninstall / store |
| 支付 | `/pay` | products / orders / membership（可选 app-pay 服务） |
| 壁纸 | `/wallpaper` | upload / file / preset |
| 偏好 | `/preferences` | get / update（KV：wallpaper / theme） |
| 运维 | `/agent` `/health` `/cache/stats` | harness 运行时观测（admin）/ 健康检查 / 缓存命中率 |

完整交互式文档：启动后访问 `http://localhost:8000/docs`

---

## 测试

### RAG 诊断（P0 自检）

```bash
python -m app.test.rag.diagnose_rag
```

验证 Milvus / embedding / LLM 全链路可用。

### 后端单元测试

```bash
pytest app/test/ -v          # 按业务域分包：agents / chat / kg / notes / quiz / rag / harness ...
```

### Agent 真实集成测试

```bash
export BILIRAG_REAL_AGENT_HARNESS_TESTS=1
export LLM__API_KEY="你的真实 LLM Key"
pytest app/test/real_agent_harness -v -s
```

默认不设开关时全部 skip（不消耗真实资源）。

### 独立服务测试

```bash
cd app-task && go test ./...            # Go 调度器（76 个测试）
cd app-board && go test ./...           # Go 板存储（22 个测试）
cd app-pay-admin && go test ./...       # Go 支付后台（31 个测试）
cd app-pay && mvn test                  # Java 交易服务（82 个测试）
```

### 前端

```bash
cd frontendv2
npm run lint && npx tsc --noEmit
```

---

## 开发约束

- **前端**：所有请求通过 `frontendv2/lib/api/`，组件内不直接 `fetch`
- **后端 Router**：只做参数解析 + 鉴权 + 调 service，不写业务逻辑
- **分层**：router → service → repository → DB/Milvus/Mongo，禁止反向调用
- **Agent**：新子 agent 仿 memory/note 模式（5 节点 ReAct + handlers + `list_tool_defs(names=[...])` 过滤），经 `delegate_to_agent` 接入
- **配置**：新增配置项同步更新 `.env.example` + `default.yaml` + `docs/configuration.md`
- **安全**：不提交 `.env` / 数据库 / 密钥；API Key 用 `SecretStr`；不打印完整 prompt
- **提交**：`[模块] type: 说明`（模块如 chat/rag/frontend/board/pay/agent）
- 完整开发规范见 [AGENTS.md](AGENTS.md)

---

## 目录索引

```text
app/                             FastAPI 主后端
  agent/                 LangGraph agents (chat / memory / note / code / search / summary / quiz / task_quiz)
  harness/               AgentHarness (orchestrator + runtime + lifecycle + scheduler + skills)
  routers/               FastAPI 路由（薄层）
  services/              业务服务 (rag / kg 知识图谱 / chat / notes / cloud 云盘 / blindspot 盲区 /
                         quiz / llm 凭证与用量 / auth / wallpaper / preferences / doc_parser ...)
  repository/            数据访问 (MySQL / Mongo / Milvus / Neo4j)
  tools/                 Agent 工具 (vector_search / kg_search / run_code / delegate / context / skill ...)
  infra/                 基础设施 (config / mysql / mongo / redis / minio / neo4j / milvus / 多级缓存)
  config/                YAML 配置 (default.yaml / config.yaml)
  response/              Pydantic 请求/响应 schema
  models.py              SQLAlchemy ORM 模型
  test/                  测试（按业务域分包）+ diagnose_rag 诊断

frontendv2/                      当前前端（frontend/ 已废弃，仅存档）
  app/                   Next.js App Router（chat / favorites / notes / mindmap / cloud-drive /
                         quiz / task-quiz / graph / blindspot / skills / billing / settings ...）
  components/            UI 组件（按功能域组织）
  lib/api/               唯一 API 调用入口（分模块封装，禁止组件内直接 fetch）
  lib/chat-stream.ts     SSE 流式响应解析
  lib/board-store.ts     思维导图存储桥（桌面端 mindmap.ts 的 Web 版）
  app/globals.css        Tailwind v4 主题 tokens（Apple 风格设计系统）

app-board/                       思维导图/白板存储服务（Go + Gin，:8004，HTTPS-only）
  internal/              config / db / mongo / redis缓存 / repo / service / router / tls
  certs/                 自动生成的开发 CA + 叶子证书（APISIX 信任锚）

app-task/                        定时任务调度器（Go + Gin，:8001；DB 轮询 scheduler + 邮件投递）
  web/                   嵌入式 WebUI 控制台（go:embed，登录 admin / app-task-admin）
  internal/              config / db / model / repo / service / executor(http+lua) / queue / router

app-pay/                         交易/会员服务（Java 17 + Spring Boot 3 + MyBatis-Plus，:8002 HTTPS-only）
app-pay-admin/                   支付后台管理（Go + Gin SSR，:8003 回环）

mind-base-desktop/               桌面端（Tauri 2 + React 19，全本地 SQLite）

apisix/                          APISIX 网关声明式配置（路由/上游/forward-auth/key-auth）
nginx/                           nginx 统一入口（TLS + 页面/接口分发 + 缓存）

docker-compose.yml               主服务（默认 profile = 全栈）
docker-compose.daytona.yml       Daytona 代码沙箱（可选）
deploy/china/                    中国大陆镜像部署替代方案
```

---

## 常见问题

### Q: 本地开发用什么数据库？

必须配置 `RDBMS__URL`（默认 YAML 不带 SQLite 兜底）。本地最简单起一个 MySQL Docker；Docker 部署 compose 会自动起 MySQL 并注入连接串。

### Q: 壁纸/云盘上传需要 MinIO 吗？

是。壁纸自定义上传和云盘文件都存 MinIO（Docker 部署默认启用）。本地裸跑需 `MINIO__ENABLED=true` + 配置 `MINIO__ACCESS_KEY` / `MINIO__SECRET_KEY`；未启用时壁纸仍可用预设图，云盘功能降级。

### Q: Code Agent / 技能代码需要 Daytona 吗？

是。`run_code` / `run_skill_code` 在 Daytona 沙箱运行代码。未配置时（`DAYTONA__ENABLED=false`）工具不注册，delegate 到 code agent 会 fallback，其他 agent 不受影响。可用 `docker-compose.daytona.yml` 自托管。

### Q: 笔记功能需要 MongoDB 吗？

是。笔记正文和修订存 MongoDB，元数据存 MySQL。未连接 MongoDB 时创建/更新笔记抛 `RuntimeError`。

### Q: 知识图谱需要 Neo4j 吗？

是。构建与检索都依赖 Neo4j（compose 已内置 `neo4j` 服务，默认 profile 自动拉起）。未连接时自动降级：`kg_search` 工具不注册、图谱面板显示不可用，其余功能不受影响。密码经 `.env` 的 `NEO4J_PASSWORD` 与后端 `KG__PASSWORD` 共享。

### Q: 思维导图/白板数据存哪里？

元数据在主 MySQL 的 `board` 表，正文在 Mongo `board_documents` 集合，由独立 Go 服务 app-board 管理（经 APISIX `/board/*` 访问，`If-Match` 乐观锁防并发覆盖）。

### Q: 支付/会员是必装的吗？

不是。app-pay 系列在 `--profile pay` / `--profile full` 才启动；主知识库功能完全不依赖它。

### Q: 如何切换 LLM Provider？

前端导航栏 → `API 设置` → 新建 Credential（Provider + API Key + Base URL），设为默认。支持 OpenAI / DashScope / DeepSeek / Custom；对话模型层还支持 OpenRouter 切换（`LLM__PROVIDER` / `OPENROUTER__API_KEY`）。

---

## 相关文档

- [系统架构总览](docs/architecture.md)
- [配置说明](docs/configuration.md)
- [部署指南](docs/deployment.md)
- [快速入门（本地开发）](docs/getting-started.md)
- [笔记系统](docs/notes.md)
- [定时出题任务](docs/app-task.md)
- [思维导图/白板服务](docs/app-board.md)
- [交易/会员服务](docs/app-pay.md)
- [支付后台管理](docs/app-pay-admin.md)
- [桌面端](docs/mind-base-desktop.md)
- [Quiz Harness](docs/quiz_harness.md)
- [代码执行](docs/code-execution.md)
- [开发规范](AGENTS.md)

---

## License

MIT
