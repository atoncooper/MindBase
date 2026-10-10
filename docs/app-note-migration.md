# app-note 笔记服务迁移（app/ → app-go/app-note）

> 2026-10-04。规范见 [AGENTS.md §2.15](../AGENTS.md)；本文是实施记录 + 切流/回滚手册。
>
> **状态：已切流 + Python 侧已下线**（APISIX `notes_user` 指向 app-note；`main.py` 已注销 notes 路由；旧 Python 笔记代码已删除，见 §5）。

## 1. 迁移了什么

| 组件 | 迁移前（Python，主 app） | 迁移后 |
|------|------------------------|--------|
| CRUD / 锚点 / 修订 / 分享 | `routers/notes.py` + `services/notes/service.py` | `app-go/app-note`（Gin，端口 8008） |
| markdown 消毒 | `services/notes/markdown.py`（三条正则） | `internal/service/sanitize.go`（逐标签扫描等价实现） |
| MySQL 元数据 | `repository/note_repository.py` | `internal/repo/notes.go`（schema 所有权随之迁移） |
| Mongo 正文/修订 | `repository/mongo_note_repository.py` | `internal/repo/mongo_notes.go`（同集合同结构，零迁移） |
| note agent 落库 | 工具直调 `get_note_service()` | 工具 → `services/notes/m2m_client.py` → APISIX `/internal/note/*`（key-auth + X-Uid） |

**不变**：对外路径 `/notes/*`、wire 契约（snake_case 键、409 结构化 detail、`X-Total-Count`、naive-UTC 时间格式）、存储拆分（MySQL 元数据 + Mongo 正文）。

**已知 wire 差异（有意）**：`GET /notes/{uuid}/revisions` 不再返回 `content_md`。Python 版声明了必填字段但投影排除了它，有修订时实际 500（潜在 bug）；前端 `NoteRevision` 类型只消费 `revisionId/revisionNote/createdAt`，Go 版按真实契约输出。

## 2. 请求链路（切流后）

```
浏览器 ──nginx(/notes 透传)──► APISIX notes_user(priority 50, forward-auth 宽验证)
                                ├─ /notes/shared/{token} 免登录（nginx 缓存 60s）
                                └─ 其余端点信任注入的 X-Uid ──► app-note:8008

note agent(Python) ──MCP(app-note-mcp:8009, 服务模式)──APISIX note_internal(priority 100, key-auth)──► /internal/note/* ──► app-note

AI 操作笔记的唯一通道是 app-note-mcp（Go + mcp-go，对齐 app-board-mcp 惯例）：
工具 save_note/list_notes/get_note/update_note；uid 由 graph 注入 _uid → MCP
服务模式 X-Uid 头，LLM 参数中永不出现；Python 工具仅是 MCP 代理（app/tools/notes/*）。
```

## 3. 上线步骤

1. **构建推送镜像**：CI（`docker-build.yml` 已含 app-note 条目）推送 `atoncooper/mind-base-app-note:latest`；或手动 `docker compose build app-note`。
2. **起服务（未切流）**：`docker compose up -d app-note`，验证 `curl 127.0.0.1:8008/health` 返回 200（MySQL down 时 503，属预期探活语义）。
3. **兼容性验证**（切流前必做，用真实数据）：
   - 旧笔记 / 分享 / 修订在 Go 服务上可读（直连 8008 带 X-Uid 头打 `/notes` 系列端点）；
   - 新旧端点响应逐字段 diff（建议同一会话分别打 Python `:8000` 与 Go `:8008`）；
   - note agent 冒烟：对话式 `save_note` → 前端笔记列表可见（验证 `/internal/note/*` key-auth 通路）。
4. **切流**：重载 APISIX（`apisix.yaml` 已含 `notes_user` / `note_internal` / `upstream-app-note`）。nginx 零改动。
5. **观察**：`logs/app-note.log` + 访问日志中的 `request_id` 字段可与 APISIX 请求 id 对链。

## 4. 回滚（一个发布周期内）

删除 APISIX `notes_user` 路由（或将其 upstream 改回 `upstream-backend`）即回落 Python 旧实现——`routers/notes.py`、`services/notes/`、`repository/*_note_repository.py` 原样保留。

⚠️ 回滚注意：切流期间经 Go 服务产生的数据对 Python 版完全兼容（同库同集合、naive-UTC 时间、sha256 hash、快照策略均逐条复刻），无需数据回填。唯一前提是 Python 版修订列表端点对"有修订的笔记"存在 500 bug（见 §1 wire 差异），该端点在旧版本就如此，不构成回滚障碍。

## 5. 清理记录（已执行 2026-10-04）

- ✅ 已删除：`app/routers/notes.py`、`app/services/notes/service.py|markdown.py`（`m2m_client.py` 保留）、`app/repository/note_repository.py`、`app/repository/mongo_note_repository.py`、`app/response/notes.py`、`app/test/notes/test_notes_service.py|test_notes_markdown_safety.py`；`app/main.py` 已注销路由（行为契约由 Go 测试接管）。
- `models.py` 的 Note/NoteAnchor/NoteShare ORM 类保留（无运行时效果；schema 文档作用，删除需按 AGENTS 规矩单独评估）。
- `app/models.py` 中 Note ORM 保留只读（RAG/workspace 侧若有元数据读取需确认）。
- Mongo 索引声明（`app/infra/mongo.py` 的 note 两集合段）可移除（app-note 启动自建）。

## 6. 测试基线

- Go：`cd app-go/app-note && go test ./...`（guard / sanitize 逐条对齐 Python 安全用例 / service 行为 / router wire 契约 + 503 映射）。
- Python：`pytest app/test/agents/ app/test/services/test_note_conversion.py -q`（工具已改为 app-note-mcp 的 MCP 代理，落库链路见上）。
- CI：`ci-app-note.yml`（gofmt/vet/test/build）随 PR 触发。
