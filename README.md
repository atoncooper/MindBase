# 🚀 Bilibili RAG：把收藏夹变成可对话的知识库

把你在 B 站收藏的访谈/演讲/课程，变成可检索、可追溯来源的**个人知识库**。
适合：访谈/演讲/课程、技术视频与学习视频整理、公开课复盘、知识总结、会议/分享回顾、播客内容归档等。

> 亮点：自动拉取内容 → 语音转写 → 向量检索 → 对话问答

---

## ✨ 功能一览

- ✅ B 站扫码登录 + **邮箱密码登录**，读取收藏夹
- ✅ 支持**分 P 视频**的逐 P 处理与向量化
- ✅ **云盘文件上传**（Markdown / HTML / DOCX / 纯文本），自动向量化入库
- ✅ 音频转文字（ASR），自动兜底处理
- ✅ 语义检索（向量检索）+ **Agentic RAG** 智能问答
- ✅ 多路由策略（direct / db_list / db_content / vector）自动选择
- ✅ **Milvus** 向量数据库（按月分区）+ MySQL + Redis + MongoDB + MinIO 基础设施
- ✅ 多 Provider API Key 管理（OpenAI / Anthropic / DeepSeek / 自定义）
- ✅ **API 配置测试** — 一键验证 LLM / Embedding / ASR 连接
- ✅ Dashboard 设备管理 + Token 会话列表
- ✅ **LangSmith** 自动追踪集成，可观测 LLM 调用链路

---

## 🖼️ 演示与截图

![首页截图](assets/screenshots/home.png)
![对话界面截图](assets/screenshots/chat.png)

## B站演示视频：
[演示视频](https://b23.tv/bGXyhjU)

## 🏗️ 系统架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              前端 (Next.js 15)                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ SourcesPanel │  │  ChatPanel   │  │  LoginModal  │  │ASRViewer... │ │
│  │ 收藏夹/来源   │  │  对话面板     │  │  扫码登录     │  │ 转写查看    │ │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘  └─────────────┘ │
│         └─────────────────┘                                             │
│                    │                                                    │
│         ┌──────────┴──────────┐                                       │
│         │    lib/api.ts       │  ← 唯一 API 调用入口                   │
│         └──────────┬──────────┘                                       │
└────────────────────┼────────────────────────────────────────────────────┘
                     │ HTTP / SSE
┌────────────────────┼────────────────────────────────────────────────────┐
│                    ▼                                                    │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    FastAPI 后端 (Python)                         │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │   │
│  │  │ /auth    │ │/favorites│ │ /chat    │ │/knowledge│          │   │
│  │  │ 认证     │ │ 收藏夹   │ │ 对话     │ │ 知识库   │          │   │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘          │   │
│  │  ┌────┴────────────┴────────────┴────────────┴────┐            │   │
│  │  │              Services 业务层                    │            │   │
│  │  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐  │            │   │
│  │  │  │bilibili│ │content_│ │  asr   │ │  rag   │  │            │   │
│  │  │  │  B站API │ │fetcher │ │ 语音转写│ │向量/RAG│  │            │   │
│  │  │  └────────┘ └────────┘ └────────┘ └────────┘  │            │   │
│  │  └───────────────────────────────────────────────┘            │   │
│  │  ┌──────────────────┐    ┌──────────────────┐                 │   │
│  │  │   MySQL           │    │   Milvus          │                 │   │
│  │  │  (结构化数据)     │    │  (向量存储,月分区) │                 │   │
│  │  └──────────────────┘    └──────────────────┘                 │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 核心链路

```
B站数据（ASR/字幕） + 云盘文件（MD/HTML/DOCX） → 文本分块 → Embedding → Milvus（按月分区）
                                                                          ↓
用户提问 ← LLM 生成回答 ← 向量检索（B站 + 云盘双路并行） ← Query Embedding
```

---

## ⚡ 快速开始

### 0) 前置依赖

| 工具 | 版本要求 | 说明 |
|------|---------|------|
| Python | >= 3.10 | 后端运行环境 |
| Node.js | >= 18 | 前端运行环境 |
| ffmpeg | 最新版 | ASR 音频处理依赖 |
| Conda (推荐) | - | Python 环境管理 |

安装 ffmpeg：
- macOS: `brew install ffmpeg`
- Windows: 下载安装包后将 `bin` 目录加入 PATH
- Linux: `apt/yum/pacman` 安装 `ffmpeg`

### 1) 安装后端依赖

```bash
conda create -n bilibili-rag python=3.10
conda activate bilibili-rag
pip install -r requirements.txt
```

### 2) 配置

```bash
cp .env.example .env
# 编辑 .env，只需要填入密钥类字段（API Key 等）
# 所有非敏感配置（端口、超时、模型名等）已在 app/config/*.yaml 中定义
```

**最小 `.env`：**

```env
LLM__API_KEY=sk-your-dashscope-key
```

> 完整配置说明 → **[docs/configuration.md](docs/configuration.md)**

### 3) 启动后端

```bash
# 方式一：直接启动
python -m uvicorn app.main:app --reload

# 方式二：使用脚本（后台运行）
# Linux/macOS:
./scripts/start.sh
# Windows PowerShell:
./scripts/start.ps1
```

后端文档：`http://localhost:8000/docs`

### 4) 启动前端

```bash
cd frontend
npm install
npm run dev
```

前端页面：`http://localhost:3000`

### 5) 停止服务

```bash
# Linux/macOS:
./scripts/stop.sh
# Windows PowerShell:
./scripts/stop.ps1
```

---

## 📂 目录结构

```
bilibili-rag/
├── app/                        # Backend root
│   ├── config/                 # YAML-based config
│   │   ├── default.yaml        #   All defaults
│   │   ├── config.yaml         #   Team-shared overrides (committed)
│   │   ├── local.yaml.example  #   Per-machine template (gitignored)
│   │   ├── loader.py           #   YAML loader + env-var merge
│   │   └── settings.py         #   Flat accessor for backward compat
│   ├── infra/                  # Infrastructure layer
│   │   ├── config.py           #   Pydantic-settings based config
│   │   ├── rdbms.py            #   Async MySQL/PostgreSQL engine
│   │   ├── redis.py            #   Redis client + pubsub
│   │   ├── milvus.py           #   Milvus vector DB client
│   │   ├── mongo.py            #   MongoDB client
│   │   ├── cache.py            #   Multi-level cache (L1 + Redis L2)
│   │   ├── minio.py            #   MinIO / S3 object storage
│   │   ├── slow_sql.py         #   Slow query capture
│   │   └── transaction.py      #   Retry + readonly routing
│   ├── database.py             # DB init + auto-migration
│   ├── main.py                 # FastAPI entry point
│   ├── models.py               # SQLAlchemy ORM models only
│   ├── response/               # Pydantic API schemas
│   │   ├── auth.py             #   Auth schemas
│   │   ├── chat.py             #   Chat schemas
│   │   ├── asr.py              #   ASR schemas
│   │   ├── quiz.py             #   Quiz schemas
│   │   ├── credentials.py      #   Credential / billing schemas
│   │   ├── favorites.py        #   Favorites v2 schemas
│   │   ├── knowledge.py        #   Knowledge base schemas
│   │   ├── metadata.py         #   Video metadata schemas
│   │   └── vector.py           #   Vectorization schemas
│   ├── repository/             # Data-access layer
│   ├── routers/                # HTTP route layer
│   │   ├── auth.py             #   QR login + password login + devices
│   │   ├── chat.py             #   Q&A orchestrator
│   │   ├── favorites_v2.py     #   Favorite folders v2
│   │   ├── knowledge.py        #   Knowledge base sync
│   │   ├── asr.py              #   Per-page ASR
│   │   ├── vector_page.py      #   Per-page vectorization
│   │   ├── credentials.py      #   Multi-provider API keys + test
│   │   ├── billing.py          #   Usage / billing
│   │   ├── quiz.py             #   Quiz training
│   │   ├── settings.py         #   Embedding / ASR config CRUD + test
│   │   └── tasks_ws.py         #   WebSocket task status
│   └── services/               # Business-logic layer
│       ├── auth/               #   User system (password, OAuth, token)
│       ├── bilibili.py         #   Bilibili API client
│       ├── asr.py              #   Speech-to-text
│       ├── rag/                #   Vector retrieval + LLM + Agentic
│       ├── llm/                #   Credential manager + config tester
│       ├── query/              #   Query rewrite
│       ├── video/              #   Video metadata extraction
│       ├── favorite/           #   Favorite sync service
│       └── wbi.py              #   WBI anti-crawl signing
│
├── frontend/                   # Next.js frontend
│   ├── app/                    # App Router (page.tsx, layout.tsx)
│   ├── components/             # React components
│   │   ├── QRLoginModal.tsx    #   QR code login
│   │   ├── PasswordLoginModal.tsx  # Password login
│   │   ├── dock-modules/       #   Settings, Billing, Quiz panels
│   │   └── three/              #   Three.js 3D scene
│   └── lib/                    # API client, device detection, etc.
│
├── docs/                       # Documentation
├── .github/workflows/          # CI/CD (backend lint, frontend build, Docker)
├── docker-compose.yml          # Full-stack Docker Compose
├── Dockerfile                  # Backend Docker image
└── requirements.txt            # Python dependencies
```

---

## 🧠 工作流程

```
1. 扫码登录 → 获取收藏夹列表
2. 选择收藏夹 → 点击「入库/更新」
3. 系统执行：拉取视频 → 音频转写（ASR）→ 生成向量 → 写入 Milvus
4. 上传文档到云盘 → 自动解析 → 向量化入库（Markdown / HTML / DOCX / 纯文本）
5. 在 ChatPanel 中提问，系统自动选择最佳路由策略回答（B站 + 云盘双路检索）
```

### 分P视频支持

对于多 P 视频（合集/课程），系统支持：
- 逐 P 展示列表
- 单 P 独立的 ASR 转写
- 单 P 独立的向量化入库
- 工作区勾选，精确选择要检索的分 P 范围

### 路由策略

对话接口采用智能路由，自动选择最佳回答策略：

| 路由 | 说明 | 使用场景 |
|------|------|----------|
| `direct` | 直接回答 | 寒暄、闲聊、通用问题 |
| `db_list` | 列表回答 | "有哪些"、"清单"、"目录"类问题 |
| `db_content` | 内容总结 | "总结"、"概述"、"分析"类问题 |
| `vector` | 向量检索+RAG | 具体主题问题，需要检索相关内容 |

---

## 🔌 API 文档

系统提供完整的 RESTful API，交互式文档在启动后自动可用：

- **Swagger UI**: `http://localhost:8000/docs`
- **ReDoc**: `http://localhost:8000/redoc`
- **OpenAPI YAML**: 见 [`api/openapi.yaml`](api/openapi.yaml)
- **API 文档说明**: 见 [`api/README.md`](api/README.md)

### 主要接口分组

| 分组 | 路径前缀 | 说明 |
|------|----------|------|
| 认证 | `/auth` | 扫码登录、会话管理 |
| 收藏夹 | `/favorites` | 收藏夹列表、视频、整理 |
| 对话 | `/chat` | 智能问答、流式问答、搜索 |
| 知识库 | `/knowledge` | 同步、构建、状态、清空 |
| ASR | `/asr` | 分P视频语音转写 |
| 分P向量 | `/vec/page` | 分P视频向量化任务 |

---

## 🤖 OpenClaw Skill（本地接入）

本仓库已提供一个可直接使用的 Skill：`skills/bilibili-rag-local/SKILL.md`。
作用：把本地运行的 `bilibili-rag` 服务接入 OpenClaw，让 OpenClaw 直接调用你的收藏夹知识库进行检索和问答。

### 前置条件

1. 先按上面的步骤完成本项目本地部署。
2. 确认后端接口可访问：`http://127.0.0.1:8000/docs`。
3. 确认 OpenClaw 已安装并可加载本地 Skills。

### 接入方式

1. 将本仓库中的 `skills/bilibili-rag-local` 放到 OpenClaw 的 Skills 目录（例如 `~/.openclaw/skills/`）。
2. 重启或刷新 OpenClaw Skills。
3. 在 OpenClaw 中调用该 Skill，让它通过本地 API 执行：
   - `POST /chat/ask`（问答）
   - `POST /chat/search`（检索片段）
   - `GET /knowledge/folders/status`（入库状态）

### 使用建议

1. 先同步/入库收藏夹，再进行问答。
2. 问题越具体，召回效果越好。
3. 若出现"无命中"，优先检查是否完成入库或是否选错收藏夹。

---

## 🧩 基于 Skill 的扩展示例

你可以在 `skills/` 目录继续开发更多 Skill，把收藏夹真正变成可持续运营的知识系统。
例如结合 OpenClaw 的定时能力（Cron）做自动化：

1. 每日/每周统计收藏夹入库状态（新增、未入库、失败项）。
2. 定时生成"新增收藏学习摘要"（按主题聚合要点）。
3. 定时输出"待补全内容清单"（ASR 失败、内容过短、召回弱视频）。
4. 将统计结果自动推送到你常用的消息渠道，形成固定复盘节奏。

---

## 🧪 测试与诊断

```bash
# 向量检索链路自检（P0，每次提交前必须运行）
python test/diagnose_rag.py

# 聊天接口测试（修改 chat/rag 后运行）
python test/test_chat.py

# 同步链路测试（修改 knowledge/asr 后运行）
python test/test_sync.py
```

---

## 🎧 ASR 说明（音频不可达兜底）

部分 B 站音频 URL 可能返回 403（直链不可拉取），系统会自动执行兜底流程：

1. 本地下载音频（带 Cookie）
2. ffmpeg 转码为 16k 单声道
3. 上传到 DashScope 后再识别

> 请确保本机已安装 `ffmpeg` 并加入 PATH。

---

## 💰 费用说明（DashScope）

模型相关费用包括：
- LLM 对话（按 Token）
- Embedding（按 Token）
- ASR 音频转写（按时长）

建议：
- 部署/测试阶段先用 **短视频（约 10 分钟）**验证流程与费用
- 正式使用按需启用，注意费用；大多数模型有免费额度，通常足够日常使用

---

## 🧩 技术栈

### 后端
- **Web 框架**: FastAPI + Uvicorn
- **LLM 调用**: LangChain + OpenAI SDK (DashScope 兼容模式)
- **向量库**: Milvus
- **数据库**: MySQL + SQLAlchemy (异步) + Repository 模式
- **缓存**: Redis (L1 内存 + L2 Redis)
- **文档存储**: MongoDB
- **配置**: YAML 分层配置 + env 密钥注入
- **用户系统**: Snowflake UID + OAuth + 邮箱密码登录 + RBAC
- **语音转写**: DashScope ASR (Paraformer)
- **可观测性**: LangSmith 自动追踪 + Slow SQL 捕获

### 前端
- **框架**: Next.js 16 (App Router)
- **语言**: TypeScript
- **3D**: Three.js / React Three Fiber (R3F)
- **样式**: Tailwind CSS + CSS Variables
- **图标**: Lucide React

---

## 📂 数据存储

| 数据 | 存储位置 | 说明 |
|------|---------|------|
| 用户体系 | MySQL | users / user_oauth / user_tokens / RBAC / devices |
| 收藏夹列表 | MySQL | 结构化数据 |
| 视频元数据 | MySQL | 标题、简介、分P |
| ASR 全文 | MongoDB | asr_documents 集合 |
| 向量数据 | Milvus（按月分区） | Embedding 向量 + chunk metadata |
| 聊天消息 | MongoDB | chat_messages 集合 |
| 文件存储 | MinIO | 云盘上传文件（Markdown/HTML/DOCX/视频）
| 缓存 | Redis | Token、用户信息、Credential |
| 题库 | MySQL | quiz_sets / quiz_answers / quiz_submissions |

---

## ✅ 常见问题

**Q：为什么有些音频 URL 可达、有些不可达？**
A：B 站音频直链存在鉴权/过期/区域限制，只有公网可直接拉取的 URL 才可达。

**Q：分 P 视频如何入库？**
A：在 SourcesPanel 中展开分 P 列表，可以对单 P 执行「转文字」和「向量化」。也支持整批处理。

**Q：对话返回"未检索到相关内容"怎么办？**
A：检查 1) 是否已完成收藏夹入库；2) 是否选中了正确的收藏夹；3) 问题是否与视频内容相关。

**Q：如何查看 LLM 调用链路？**
A：配置 `LANGSMITH_API_KEY` 后，访问 LangSmith 控制台即可查看每次问答的完整 trace。

**Q：支持哪些 LLM 模型？**
A：任何兼容 OpenAI API 格式的模型均可，如 DashScope、OpenAI、Anthropic (通过代理) 等。

---

> 免责声明：本项目仅供个人学习与技术研究，使用者需自行遵守相关平台协议与法律法规，禁止用于未授权的商业或违规用途。

---

## 📜 License

MIT

---

## 🧩 TodoList

- [x] 分 P 视频支持与逐 P 向量化
- [x] Agentic RAG 智能问答模式
- [x] 用户系统 v2（Snowflake UID + OAuth + 邮箱密码 + RBAC）
- [x] 多 Provider API Key 管理（LLM / Embedding / ASR）
- [x] API 配置一键测试
- [x] 设备管理与 Token 会话列表
- [x] Milvus + MySQL + Redis + MongoDB 基础设施
- [x] LangSmith 可观测性集成
- [x] CI/CD（GitHub Actions lint + typecheck + Docker build）
- [ ] Rerank 重排序提升检索精度
- [ ] 增量同步（只处理新增/变更视频）
- [ ] 字幕优先策略（有官方字幕时跳过 ASR）
- [ ] Celery 异步任务队列
