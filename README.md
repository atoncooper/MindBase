# MindBase 知识库

MindBase 是一个个人知识库 RAG 系统，把 B 站收藏和云盘文档转化为可检索、可问答、可复习的知识。

核心链路：同步 B 站收藏夹 → ASR 语音转文字 → 文本向量化（embedding）→ 写入 Milvus → ReAct Agent 流式问答（来源追踪）。

除问答外，AI 还能自动生成 Markdown 笔记（Note Agent）、在 Daytona 沙箱运行代码（Code Agent）、按内容出题练习（Quiz）、定时出题邮件提醒（app-task，独立服务 + XXL-JOB 调度）。前端提供 macOS 风格桌面：壁纸背景（静态/动态 mp4）、Dock 栏、Launchpad 启动台、可拖拽拉伸的桌面小组件（日期/时钟/日历/待办/便签）。

后端 FastAPI + LangGraph multi-agent（Chat / Memory / Note / Code / Quiz 五个 agent，经 delegate 按需调用）。存储：MySQL + Milvus + MongoDB + Redis + MinIO + Daytona（可选）。前端 Next.js 16。支持 OpenAI / DashScope / DeepSeek 多 LLM Provider。

适合「收藏了很多但没时间整理」的学习者，把碎片化收藏变成可用的知识库。

---

## 快速启动（本地开发）

### 前置要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Python | >= 3.10 | 后端运行环境 |
| Node.js | >= 18 | 前端运行环境 |
| ffmpeg | 任意 | ASR 音频处理依赖 |
| Docker | >= 24（可选） | 容器化部署 / Milvus / MinIO |

### 1. 克隆 + 创建 conda 环境 + 安装依赖

```bash
git clone https://github.com/atoncooper/MindBase.git
cd MindBase

# 创建 conda 环境（Python 3.10+）
conda create -n mindbase python=3.10 -y
conda activate mindbase

# 后端依赖
pip install -r requirements.txt

# 前端依赖
cd frontend && npm install && cd ..
```

### 2. 配置环境变量

创建 `.env`（参考 `.env.example`）。最小可运行配置（SQLite + LLM）：

```bash
# .env
LLM__API_KEY=sk-你的key
RDBMS__URL=sqlite+aiosqlite:///./data/mind_base.db
```

使用 DashScope（通义千问）：

```bash
LLM__API_KEY=你的DashScope Key
LLM__MODEL=qwen-plus
LLM__BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
RDBMS__URL=sqlite+aiosqlite:///./data/mind_base.db
```

启用完整功能（Milvus + Mongo + MinIO）：

```bash
LLM__API_KEY=sk-xxx
RDBMS__URL=mysql+aiomysql://root:password@127.0.0.1:3306/mindbase
MILVUS__ENABLED=true
MILVUS__URI=http://localhost:19530
MONGO__ENABLED=true
MONGO__URI=mongodb://localhost:27017
REDIS__ENABLED=true
REDIS__URL=redis://localhost:6379/0
MINIO__ENABLED=true
MINIO__ACCESS_KEY=minioadmin
MINIO__SECRET_KEY=minioadmin
```

配置加载顺序（后者覆盖前者）：

```text
app/config/default.yaml  ->  app/config/config.yaml  ->  local.yaml  ->  环境变量(.env)
```

环境变量双下划线映射：`段__键` -> `config["段"]["键"]`。

<details>
<summary>完整环境变量表</summary>

| 变量 | 说明 | 示例 |
|------|------|------|
| `LLM__API_KEY` | LLM API 密钥 | `sk-xxx` |
| `LLM__MODEL` | 模型名 | `qwen-plus` |
| `LLM__BASE_URL` | LLM API 地址 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `RDBMS__URL` | 数据库连接 | `sqlite+aiosqlite:///./data/mind_base.db` |
| `MILVUS__ENABLED` | 启用 Milvus | `true` |
| `MILVUS__URI` | Milvus 地址 | `http://localhost:19530` |
| `MONGO__ENABLED` | 启用 MongoDB | `true` |
| `MONGO__URI` | MongoDB 地址 | `mongodb://localhost:27017` |
| `REDIS__ENABLED` | 启用 Redis | `true` |
| `REDIS__URL` | Redis 地址 | `redis://localhost:6379/0` |
| `MINIO__ENABLED` | 启用 MinIO | `true` |
| `MINIO__ACCESS_KEY` | MinIO Access Key | `minioadmin` |
| `MINIO__SECRET_KEY` | MinIO Secret Key | `minioadmin` |
| `DAYTONA__ENABLED` | 启用 Daytona | `true` |
| `DAYTONA__API_URL` | Daytona 沙箱地址 | `http://daytona:3000` |
| `DAYTONA__API_KEY` | Daytona API Key | `xxx` |

</details>

完整配置见 [`docs/configuration.md`](docs/configuration.md)。

### 3. 启动后端

```bash
uvicorn app.main:app --reload --port 8000
```

验证：

```bash
curl http://localhost:8000/health
# {"status": "healthy"}
# Swagger UI: http://localhost:8000/docs
```

### 4. 启动前端

```bash
cd frontend
npm run dev
```

验证：浏览器打开 `http://localhost:3000`，应看到登录页。

前后端不同 origin 时：

```bash
export NEXT_PUBLIC_API_URL="http://localhost:8000"
export NEXT_PUBLIC_WS_URL="localhost:8000"
```

### 5. 快速验证全链路

```
1. 打开 http://localhost:3000 -> 扫码登录 B 站
2. Dock -> 收藏夹 -> 同步 -> 选收藏夹 -> 构建（ASR + 向量化）
3. 构建完成后 -> Dock -> 对话 -> 提问
4. 右键桌面 -> 更换壁纸 / 添加组件
```

---

## Docker 部署（生产级）

### 一键启动

```bash
# 1. 复制配置
cp .env.example .env
# 编辑 .env：至少填 LLM__API_KEY

# 2. 启动全部服务
docker compose up -d --build

# 3. 查看状态
docker compose ps

# 4. 查看日志
docker compose logs -f backend
```

启动的服务：

| 服务 | 端口 | 说明 |
|------|------|------|
| nginx | 80 / 443 | 反代 + TLS + 壁纸缓存 |
| frontend | 3000（内部） | Next.js standalone |
| backend | 8000（内部） | FastAPI |
| MySQL | 3306 | 结构化数据 |
| Redis | 6379 | 缓存 / 异步任务 |
| MongoDB | 27017 | 聊天历史 / 笔记正文 / ASR 文档 |
| Milvus | 19530 | 向量检索 |
| MinIO | 9001（控制台） | 文件 / 壁纸存储 |

### 验证

```bash
# 健康检查
curl http://localhost/health
# {"status": "healthy"}

# 前端
curl -s http://localhost | head -5
# <!DOCTYPE html>...

# Swagger
# 浏览器打开 http://localhost/docs
```

### Daytona 代码沙箱（可选）

Code Agent 的 `run_code` 工具需要 Daytona 沙箱运行代码。未配置时 code agent 自动降级（其他 agent 不受影响）。

```bash
# 1. 先起主服务（创建 mind-base-net 网络）
docker compose up -d

# 2. 独立起 Daytona
docker compose -f docker-compose.daytona.yml up -d

# 3. 在 .env 加配置
# DAYTONA__ENABLED=true
# DAYTONA__API_URL=http://daytona:3000
# DAYTONA__API_KEY=<你的 Daytona API Key>

# 4. 重启 backend
docker compose restart backend
```

### 使用 profile 控制服务范围

```bash
# 仅前端 + 后端 + 数据库（最小，无向量库/对象存储）
docker compose --profile "" up -d

# 含存储栈（Milvus + MinIO）
docker compose --profile storage up -d

# 全部（含工具）
docker compose --profile full up -d

# 定时出题任务栈（app-task + APISIX + XXL-JOB + 前端）
docker compose --profile task up -d
```

### 生产 HTTPS（nginx + Let's Encrypt）

项目自带 nginx 配置（`nginx/nginx.conf`），支持 HTTPS + ACME 自动证书：

```bash
# 1. 将域名 DNS 指向服务器
# 2. 把证书放 nginx/certs/（或用 certbot 自动申请）
# 3. docker compose up -d
# nginx 自动监听 80/443，80 -> 301 -> 443
```

nginx 已配置：
- `/wallpaper/*` `/wallpapers/*` -> proxy_cache wallpaper_cache（7 天）
- `/_next/static` -> expires 1y immutable
- SSE `/chat/ask/stream` -> proxy_buffering off
- 上传 `/cloud/*` -> client_max_body_size 5g

### 故障排查

```bash
# 后端启动失败
docker compose logs backend | tail -50

# 前端构建失败
docker compose logs frontend | tail -50

# Milvus 连不上
docker compose logs milvus
# 确认 MILVUS__ENABLED=true 且 etcd 正常

# MongoDB 连不上（笔记/聊天历史报错）
docker compose logs mongo
# 确认 MONGO__ENABLED=true

# 数据库迁移
# 后端启动时自动执行 CREATE TABLE IF NOT EXISTS + 列迁移，无需手动操作

# 清理重来
docker compose down -v   # -v 删除数据卷（谨慎！）
docker compose up -d --build
```

详见 [`docs/deployment.md`](docs/deployment.md)。

## 功能模块

### 对话（Agentic Chat）

- **入口**：Dock `对话`
- **Agent**：Chat（默认路由）+ Memory / Note / Code（经 delegate 调用）
- **流式 SSE**：route / chunk / step / sources / done / error 六种事件
- **工具**：vector_search / list_videos / get_video_summaries / delegate_to_agent

### 收藏夹

- **入口**：Dock `收藏夹`
- 同步 B 站收藏夹与视频列表，分 P 查看、ASR 内容、向量化状态
- 支持整理预览（清理无效视频）

### 云盘

- **入口**：Dock `云盘`
- 文件夹树、上传（分片直传 MinIO）、搜索、排序、批量处理
- WebSocket 实时推送处理状态（ASR / 向量化）

### 题目练习

- **入口**：Dock `题目练习`（或 Launchpad）
- 按收藏夹/分 P 出题（结构化输出），提交批改、历史回看
- 错题本 + 训练数据导出（JSONL / CSV / SFT）

### 定时出题（app-task）

- **入口**：`/task-quiz`（对话定义任务）+ `/tasks`（任务列表/答题）
- 用户与 AI 对话定义"到某时间出一道题"，AI 按北京时间随机生成触发时间（避开睡觉/午休）
- 到点自动 LLM 生成题目，HTML 邮件发给用户+抄送人，限时答题
- 超时未答发"未完成语录"提醒；邮件不含链接，需登录答题
- 独立服务（app-task + APISIX + XXL-JOB），详见 [`docs/app-task.md`](docs/app-task.md)

### 笔记

- **入口**：Dock `笔记`
- Markdown 富文本（BlockNote 编辑器），锚点定位、修订历史
- 公开分享（免登录只读），服务端二次消毒
- 详见 [`docs/notes.md`](docs/notes.md)

### API 设置 / 个人中心

- **入口**：Dock `API 设置` / `个人中心`
- LLM / Embedding / ASR 多 Provider 凭证管理，默认凭证、连接测试
- 个人资料、安全绑定（B 站/邮箱/密码）、退出登录

---

## API 概览

| 模块 | 前缀 | 主要端点 |
|------|------|---------|
| 认证 | `/auth` | 扫码登录 / 密码登录 / token 管理 |
| 收藏夹 | `/favorites` | 列表 / 同步 / 整理 |
| 知识库 | `/knowledge` | 构建 / 状态 / 清空 |
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
cd frontend
npm run lint
npm test
```

---

## 开发约束

- **前端**：所有请求通过 `frontend/lib/api.ts`，组件内不直接 `fetch`
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
  services/              业务服务 (rag / auth / notes / wallpaper / preferences / quiz / cloud ...)
  repository/            数据访问 (MySQL / Mongo / Milvus)
  tools/                 Agent 工具 (chat / notes / code / harness / context / skill)
  infra/                 基础设施 (config / minio / cache / redis / mongo)
  config/                YAML 配置 (default.yaml / config.yaml)
  response/              Pydantic 请求/响应 schema
  models.py              SQLAlchemy ORM 模型
  test/                  测试与诊断脚本

frontend/
  app/                   Next.js App Router (page.tsx / layout.tsx)
  components/            UI 组件
    dock-modules/        Dock 面板模块 (chat / favorites / notes / quiz / cloud ...)
    WallpaperBackground  壁纸背景 (静态/动态)
    Launchpad            启动台
    DesktopWidget        桌面组件容器 (拖拽+拉伸)
    *Widget              日期/时钟/日历/待办/便签
    DockBar / DockPanelWrapper / FloatingPanel
  lib/                   api.ts / auth / dock-context / widget-registry
  stores/                前端状态 (app-store)

app-task/                        定时出题任务执行器（FastAPI + pyxxl，独立服务）
  repository/ services/ executor/ routers/ templates/ apisix/

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

### Q: 如何切换 LLM Provider？

前端 Dock → `API 设置` → 新建 Credential（Provider + API Key + Base URL），设为默认。支持 OpenAI / DashScope / DeepSeek / Custom。

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
