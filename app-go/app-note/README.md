# app-note —— 笔记服务（Go + Gin）

> 笔记域唯一权威：CRUD、锚点、修订历史、公开分享、云盘文档一键转笔记。
> 存储零迁移接管（自 Python backend，2026-10-04 切流）；对外路径保持 `/notes/*`，wire 契约逐条复刻。

## 端口与路由（:8008）

| 路由 | 说明 |
|------|------|
| `/notes/*` | 用户 CRUD / 锚点 / 修订 / 分享（`If-Match` 乐观并发 → 409；`/notes/shared/{token}` 免登录） |
| `/internal/note/*` | M2M 面：mcp/app-note-mcp 经 APISIX key-auth 调用（save/list/get/update_note） |
| `/health` | 探活 |

## 数据所有权（分离存储）

- MySQL bilirag：`notes` / `note_anchors` / `note_shares`（服务启动自建 schema，禁 ALTER）
- Mongo `mind_base`：`note_documents`（正文）/ `note_revisions`（修订，快照策略 diff≥30% 且 ≥10min）
- 服务端 markdown 二次消毒（script/iframe 剥除、`javascript:` 链接替换 `#`）
- 时间契约：**naive-UTC ISO**（无 Z 后缀，逐字节兼容前端 If-Match 回传）

## 运行

```bash
go run ./app-go/app-note         # 依赖 Mongo 可达（正文存储）
docker compose up -d app-note
```

配置入口 `default.yaml`（`APPNOTE__` env 覆盖）。规范详见 AGENTS.md §2.15、docs/notes.md。
