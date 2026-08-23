# MindBase 知识库

MindBase 是一个个人知识库 RAG 系统，把 B 站收藏和云盘文档转化为可检索、可问答、可复习的知识。

核心链路：同步 B 站收藏夹 → ASR 语音转文字 → 文本向量化（embedding）→ 写入 Milvus → ReAct Agent 流式问答（来源追踪）。可选知识图谱：LLM 从转写稿抽取实体与关系写入 Neo4j（带原文引文防幻觉），问答时支持跨视频实体关联检索。

除问答外，AI 还能自动生成 Markdown 笔记（Note Agent）、在 Daytona 沙箱运行代码（Code Agent）、按内容出题练习（Quiz）、定时出题邮件提醒（app-task，Go 独立服务 + 自写 DB 轮询调度）。前端采用 Apple 风格界面：顶部导航栏承载功能，黑白极简，壁纸背景（静态/动态 mp4）。

后端 FastAPI + LangGraph multi-agent（Chat / Memory / Note / Code / Quiz 五个 agent，经 delegate 按需调用）。存储：MySQL + Milvus + MongoDB + Redis + MinIO + Neo4j（可选，知识图谱）+ Daytona（可选）。前端 Next.js 16。支持 OpenAI / DashScope / DeepSeek 多 LLM Provider。

适合「收藏了很多但没时间整理」的学习者，把碎片化收藏变成可用的知识库。

---

## 部署与启动

详细的本地开发与生产部署步骤已拆到 `docs/`（README 只保留入口与最简命令，避免与 docs 重复漂移）。按场景选文档：

| 场景 | 文档 |
|------|------|
| **直接用 Docker 本地跑起来（⭐ 普通用户入口：装 Docker → 拉代码 → 申请 API Key → 配 .env → 启动 → 验证 → 开始用）** | [`docs/setup-guide.md`](docs/setup-guide.md) |
| **本地开发**（前置 → 克隆/依赖 → 配 .env → 起后端/前端 → 验证全链路） | [`docs/getting-started.md`](docs/getting-started.md) |
| **环境变量 / 配置参考**（完整变量表、YAML 分层加载、密钥） | [`docs/configuration.md`](docs/configuration.md) |
| **Docker 生产部署**（一键启动、profiles、HTTPS、监控、备份） | [`docs/deployment.md`](docs/deployment.md) |
| **中国大陆镜像部署**（`ghcr.io`/`gcr.io`/`quay.io` 被墙时的替代方案） | [`deploy/china/README.md`](deploy/china/README.md) |
| **定时出题任务 app-task**（功能 / 独立启动 / WebUI 登录 / 配置） | [`docs/app-task.md`](docs/app-task.md) |

### 最简命令（TL;DR）

```bash
# 本地开发
uvicorn app.main:app --reload --port 8000    # 终端 1：后端 → http://localhost:8000/docs
cd frontendv2 && npm run dev                  # 终端 2：前端 → http://localhost:3000

# Docker 生产部署
cp .env.example .env                          # 至少填 LLM__API_KEY
docker compose up -d --build

# 定时出题（可选，独立拉起 app-task；WebUI 控制台 http://localhost:8001/ 登录 admin / app-task-admin）
cd app-task && docker compose up -d --build
```

> ⚠️ 环境变量、profile 服务范围（`--profile storage/full/task`）、HTTPS/TLS、故障排查、Daytona 代码沙箱等细节请在对应的 docs/ 文档中查阅，README 不再重复维护。

---

## 功能模块

### 对话（Agentic Chat）

- **入口**：导航栏 `对话`
- **Agent**：Chat（默认路由）+ Memory / Note / Code（经 delegate 调用）
- **流式 SSE**：route / chunk / step / sources / done / error 六种事件
- **工具**：vector_search / kg_search（知识图谱实体关联检索，Neo4j 可用时注册）/ list_videos / get_video_summaries / delegate_to_agent

### 收藏夹

- **入口**：导航栏 `收藏夹`
- 同步 B 站收藏夹与视频列表，分 P 查看、ASR 内容、向量化状态
- 支持整理预览（清理无效视频）
- **知识图谱面板**：一键从视频转写稿抽取实体与关系写入 Neo4j（幂等，内容未变自动跳过），展示实体 / 关系 / 证据 / 覆盖视频统计与构建进度；未连接 Neo4j 时自动降级为不可用态

### 知识图谱（kg_search）

- 构建链路：收藏夹 → 圈定已转写分P → LLM 结构化抽取（每条关系必须携带原文引文）→ 校验防幻觉边 → 写 Neo4j + 实体向量进 Milvus
- 查询链路：query 实体链接 → 子图多跳扩展 → 证据回捞（按用户收藏范围过滤），擅长「XX 在哪些视频里讲过」「A 和 B 有什么关联」类跨视频聚合问题
- 与 vector_search 协同：实体/关系/聚合类问题走图谱，内容细节走向量检索

### 云盘

- **入口**：导航栏 `云盘`
- 文件夹树、上传（分片直传 MinIO）、搜索、排序、批量处理
- WebSocket 实时推送处理状态（ASR / 向量化）

### 题目练习

- **入口**：导航栏 `题目练习`
- 按收藏夹/分 P 出题（结构化输出），提交批改、历史回看
- 错题本 + 训练数据导出（JSONL / CSV / SFT）

### 定时出题（app-task）

- **入口**：`/task-quiz`（对话定义任务）+ `/tasks`（任务列表/答题）
- 用户与 AI 对话定义"到某时间出一道题"，AI 按北京时间随机生成触发时间（避开睡觉/午休）
- 到点自动 LLM 生成题目，HTML 邮件发给用户+抄送人，限时答题
- 超时未答发"未完成语录"提醒；邮件不含链接，需登录答题
- 独立服务（app-task + APISIX），内置管理控制台 `http://localhost:8001/`（**登录 = 用户名+密码**，默认 `admin` / `app-task-admin`，生产务必改密），详见 [`docs/app-task.md`](docs/app-task.md)

### 笔记

- **入口**：导航栏 `笔记`
- Markdown 富文本（BlockNote 编辑器），锚点定位、修订历史
- 公开分享（免登录只读），服务端二次消毒
- 详见 [`docs/notes.md`](docs/notes.md)

### API 设置 / 个人中心

- **入口**：导航栏 `API 设置` / `个人中心`
- LLM / Embedding / ASR 多 Provider 凭证管理，默认凭证、连接测试
- 个人资料、安全绑定（B 站/邮箱/密码）、退出登录

---

## API 概览

| 模块 | 前缀 | 主要端点 |
|------|------|---------|
| 认证 | `/auth` | 扫码登录 / 密码登录 / token 管理 |
| 收藏夹 | `/favorites` | 列表 / 同步 / 整理 |
| 知识库 | `/knowledge` | 构建 / 状态 / 清空 / 知识图谱 kg（build / active / status / stats） |
| 聊天 | `/chat` | ask / ask/stream / sessions / history |
| ASR | `/asr` | create / update / reasr / versions |
| 向量化 | `/vec/page` | create / revector / status |
| 笔记 | `/notes` | CRUD / anchors / revisions / share |
| 题目 | `/quiz` | generate / submit / history / export |
| 定时出题 | `/task-quiz` `/tasks` | chat（定义任务）/ register / answer / 列表 |
| 云盘 | `/cloud` | upload / folders / files / stream |
| 凭证 | `/credentials` | 多 Provider API Key CRUD |
| 计费 | `/billing` | 用量统计 / by-provider / by-credential |
| 壁纸 | `/wallpaper` | upload / file / preset |
| 偏好 | `/preferences` | get / update（KV：wallpaper / theme） |
| 设置 | `/settings` | credentials / embedding-configs / asr-configs |

完整交互式文档：启动后访问 `http://localhost:8000/docs`

---

## 测试

### RAG 诊断（P0 自检）

```bash
python -m app.test.rag.diagnose_rag
```

验证 Milvus / embedding / LLM 全链路可用。

### Agent 真实集成测试

```bash
export BILIRAG_REAL_AGENT_HARNESS_TESTS=1
export LLM__API_KEY="你的真实 LLM Key"
pytest app/test/real_agent_harness -v -s
```

默认不设开关时全部 skip（不消耗真实资源）。

### 后端单元测试

```bash
pytest app/test/ -v
```

### 前端测试

```bash
cd frontendv2
npm run lint
```

---

## 开发约束

- **前端**：所有请求通过 `frontendv2/lib/api/`，组件内不直接 `fetch`
- **后端 Router**：只做参数解析 + 鉴权 + 调 service，不写业务逻辑
- **分层**：router → service → repository → DB/Milvus/Mongo，禁止反向调用
- **Agent**：新 agent 仿 memory/note 模式（5 节点 ReAct + handlers + `list_tool_defs(names=[...])` 过滤）
- **配置**：新增配置项同步更新 `.env.example` + `default.yaml` + `docs/configuration.md`
- **安全**：不提交 `.env` / 数据库 / 密钥；API Key 用 `SecretStr`；不打印完整 prompt
- **提交**：`[模块] type: 说明`（模块如 chat/rag/frontend/notes/agent/wallpaper）

---

## 目录索引

```text
app/
  agent/                 LangGraph agents (chat / memory / note / code / quiz)
  harness/               AgentHarness (orchestrator + runtime + lifecycle + scheduler)
  routers/               FastAPI 路由（薄层）
  services/              业务服务 (rag / auth / notes / kg 知识图谱 / wallpaper / preferences / quiz / cloud ...)
  repository/            数据访问 (MySQL / Mongo / Milvus / Neo4j)
  tools/                 Agent 工具 (chat 含 vector_search/kg_search / notes / code / harness / context / skill)
  infra/                 基础设施 (config / minio / cache / redis / mongo / neo4j)
  config/                YAML 配置 (default.yaml / config.yaml)
  response/              Pydantic 请求/响应 schema
  models.py              SQLAlchemy ORM 模型
  test/                  测试与诊断脚本

frontendv2/                      当前前端（frontend/ 已废弃，仅存档）
  app/                   Next.js App Router (page.tsx / layout.tsx)
  components/            UI 组件 (chat / account / settings / billing / notes / cloud-drive / quiz / task-quiz)
  lib/api/               唯一 API 调用入口（分模块封装，禁止组件内直接 fetch）
  lib/chat-stream.ts     SSE 流式响应解析
  app/globals.css        Tailwind v4 主题 tokens + .md-body 排版

app-task/                        定时出题任务执行器（Go + Gin + GORM，独立服务；docker-compose.yml 可单独拉起）
  web/                 嵌入式 WebUI 控制台（go:embed，登录 = 用户名+密码，默认 admin / app-task-admin）
  internal/             config / db / model / repo / service / executor / queue / router

docker-compose.yml              主服务
docker-compose.daytona.yml      Daytona 代码沙箱（可选）
nginx/nginx.conf                nginx 反代 + 缓存配置
```

---

## 常见问题

### Q: 本地开发用 SQLite 还是 MySQL？

本地开发推荐 SQLite（零依赖）：`export RDBMS__URL="sqlite+aiosqlite:///./data/mind_base.db"`。Docker 部署默认 MySQL。

### Q: 壁纸/云盘上传需要 MinIO 吗？

是。壁纸自定义上传和云盘文件都存 MinIO。`MINIO__ENABLED=true` + 配置 `MINIO__ACCESS_KEY` / `MINIO__SECRET_KEY`。未启用时壁纸仍可用预设图，但无法上传自定义壁纸。

### Q: Code Agent 需要 Daytona 吗？

是。Code Agent 的 `run_code` 工具在 Daytona 沙箱运行代码。未配置 Daytona 时（`DAYTONA__ENABLED=false`），`run_code` 工具不注册，delegate 到 code agent 会 fallback。其他 agent（chat/memory/note）不受影响。

### Q: 笔记功能需要 MongoDB 吗？

是。笔记正文和修订存 MongoDB，元数据存 MySQL。未连接 MongoDB 时创建/更新笔记抛 `RuntimeError`。

### Q: 知识图谱需要 Neo4j 吗？

是。构建与检索都依赖 Neo4j（docker compose 已内置 `neo4j` 服务，storage/full profile 自动拉起）。未连接时系统自动降级：`kg_search` 工具不注册、收藏夹页图谱面板显示不可用，其余功能不受影响。密码经 `.env` 的 `NEO4J_PASSWORD` 与后端 `KG__PASSWORD` 共享。

### Q: 如何切换 LLM Provider？

前端导航栏 → `API 设置` → 新建 Credential（Provider + API Key + Base URL），设为默认。支持 OpenAI / DashScope / DeepSeek / Custom。

---

## 相关文档

- [配置说明](docs/configuration.md)
- [部署指南](docs/deployment.md)
- [Docker 部署](docs/docker-deployment.md)
- [快速入门](docs/getting-started.md)
- [笔记系统](docs/notes.md)
- [Quiz Harness](docs/quiz_harness.md)
- [定时出题任务](docs/app-task.md)
- [开发规范](CLAUDE.md)

---

## License

MIT
