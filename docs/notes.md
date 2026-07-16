# 笔记（Notes）功能

面向视频 / 云盘文档的用户原创 Markdown 笔记，支持 BlockNote 富文本编辑、锚点定位、修订历史与公开分享链接。

> 笔记是**附加在某个 target（视频或云盘文件）上的用户内容**，与 RAG 检索链路解耦：笔记正文不进入向量库，不影响检索结果。

## 架构：分离存储

笔记采用 **MySQL 存元数据 + MongoDB 存正文** 的分离存储：

| 数据 | 存储 | 说明 |
|------|------|------|
| 笔记元数据（标题、target、置顶、分享、计数） | MySQL `notes` / `note_anchors` / `note_shares` | 用于列表、过滤、权限校验，轻量行 |
| 笔记正文（Markdown / BlockNote blocks JSON） | MongoDB `note_documents` | 大文本，按 `note_uuid` 唯一索引 upsert |
| 修订快照 | MongoDB `note_revisions` | 按策略写入，支持恢复 |

**为什么分离**：正文可达数百 KB，放进 MySQL 会拖慢列表查询与全表扫描；MongoDB 按 `note_uuid` 精确点查，列表只取 MySQL 的轻量行。

### 分层

```
routers/notes.py              参数解析 + 鉴权 + If-Match 解析
    │
    ▼
services/notes/service.py     业务编排：并发控制、修订快照策略、分享令牌、权限
    │
    ├──► repository/note_repository.py       MySQL 元数据（notes / anchors / shares）
    ├──► repository/mongo_note_repository.py MongoDB 正文 + 修订
    └──► services/notes/markdown.py          服务端二次消毒（去原始 HTML / 危险 URL scheme）
```

> `repository/` 与 `response/` 是笔记功能引入的两个目录层：repository 封装数据访问（MySQL + Mongo 各一个），response 存放 Pydantic 请求/响应 schema。

## 数据模型

### MySQL

**`notes`** — 笔记元数据

| 字段 | 类型 | 说明 |
|------|------|------|
| `uuid` | varchar(36) | 对外唯一标识 |
| `uid` | bigint | 所属用户（FK users.uid） |
| `title` | varchar(500) | 默认"无标题" |
| `target_type` | varchar(20) | `video` / `cloud_file` |
| `target_id` | varchar(100) | video→`bvid:cid`；cloud_file→cloud_files.id |
| `content_doc_id` | varchar(64) | MongoDB `_id`（字符串形式） |
| `content_length` | int | 正文长度 |
| `content_hash` | varchar(64) | 正文 SHA-256，脏检查用 |
| `revision_count` | int | 修订次数 |
| `is_pinned` | bool | 置顶 |
| `is_deleted` | bool | 软删除标记 |

**`note_anchors`** — 锚点（BlockNote 块到视频时间点 / 文档位置的标记）

| 字段 | 说明 |
|------|------|
| `note_id` | FK notes.id，CASCADE 删除 |
| `block_id` | BlockNote 块 ID |
| `position` | 视频秒数 / 文档偏移 |
| `label` | 可选标签 |

**`note_shares`** — 分享令牌（一条笔记可有多个分享链接）

| 字段 | 说明 |
|------|------|
| `note_uuid` | FK notes.uuid，CASCADE 删除 |
| `share_token` | 公开访问令牌（唯一） |
| `expires_at` | null = 永久 |
| `view_count` | 浏览次数 |
| `is_revoked` | 是否已撤销 |

### MongoDB

- `note_documents`：按 `note_uuid` 唯一索引 upsert，存 `content_md` + `blocks_json`。
- `note_revisions`：修订快照，按 `created_at` 倒序，排除当前正文。

## API

所有 `/notes/*` 端点除分享公开访问外均需鉴权（`get_current_uid`）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/notes/shared/{share_token}` | 公开只读访问（**无需鉴权**） |
| GET | `/notes` | 列表（可按 `target_type`/`target_id` 过滤，分页，`X-Total-Count` 头返回总数） |
| POST | `/notes` | 创建（201） |
| GET | `/notes/{note_uuid}` | 详情（正文 + 锚点 + 分享信息） |
| PATCH | `/notes/{note_uuid}` | 更新（支持 `If-Match` 乐观并发，冲突返回 409） |
| DELETE | `/notes/{note_uuid}` | 软删除（204） |
| POST | `/notes/{note_uuid}/anchors` | 添加锚点（201） |
| DELETE | `/notes/{note_uuid}/anchors/{anchor_id}` | 删除锚点（204） |
| GET | `/notes/{note_uuid}/revisions` | 修订列表 |
| POST | `/notes/{note_uuid}/revisions/restore/{revision_id}` | 恢复到指定修订 |
| POST | `/notes/{note_uuid}/share` | 创建分享（`expires_in_days`，null=永久） |
| DELETE | `/notes/{note_uuid}/share` | 撤销分享（204） |

创建请求体示例：

```json
{
  "title": "Rust 所有权要点",
  "target_type": "video",
  "target_id": "BV1xx:123",
  "content_md": "# 所有权\n..."
}
```

更新示例（带乐观并发）：

```http
PATCH /notes/{uuid}
If-Match: 2026-07-16T10:30:00+00:00
Content-Type: application/json

{ "content_md": "# 更新后的内容", "is_pinned": true }
```

冲突时返回 409：

```json
{
  "error": "conflict",
  "note_uuid": "...",
  "server_updated_at": "2026-07-16T10:35:00+00:00"
}
```

## 关键行为

### 乐观并发控制

`PATCH` 支持 `If-Match`（ISO-8601 datetime）。客户端先 `GET` 拿到 `updated_at`，更新时回传；服务端比对，若服务端版本更新则返回 409，由前端重新拉取合并。避免多人/多端编辑互相覆盖。

### 修订快照策略

更新正文时，`NoteService._should_snapshot` 决定是否写一份修订快照：

- 新内容为空 → 永不快照
- 无历史修订 + 非空新内容 → 快照
- 上次修订在 10 分钟内 → 跳过（防抖）
- 否则 diff 比例 ≥ 30% → 快照

diff 用轻量的字符级采样（非 Levenshtein），仅作快照触发启发式，够用即可。

### 软删除与修订保留

`DELETE` 软删 MySQL 行（`is_deleted=true`），**硬删** MongoDB 当前正文；修订快照**保留**，便于将来取消删除时从历史恢复。

### 公开分享

- 创建分享返回 `share_token` + `share_url`，可选 `expires_in_days`（1~365，null=永久）。
- 公开访问走 `GET /notes/shared/{token}`：无需鉴权，返回只读视图（标题、正文、target、shared_at、view_count），每次访问 `view_count` +1。
- 撤销分享置 `is_revoked=true`，公开访问即返回 404。
- 过期分享同样返回 404。

### 安全设计

| 点 | 措施 |
|----|------|
| 跨用户访问 | 返回 **404 而非 403**，避免泄漏笔记是否存在 |
| Markdown 注入 | `services/notes/markdown.py` 在写库前二次消毒：剥除 `<script>`/`<iframe>` 等原始 HTML 块、剥离残余标签、把 `javascript:`/`vbscript:`/`file:` URL 替换为 `#`（BlockNote 前端已消毒，此为纵深防御） |
| 公开分享正文 | 公开端点只返回消毒后的 `content_md`，不返回 uid 等私有字段 |

## 前端集成

- 唯一 API 入口：`frontend/lib/api.ts` 的 `notesApi`（list / create / get / update / delete / anchors / revisions / share / shared）。
- Dock 面板：`frontend/components/dock-modules/notes/`（编辑器 `editor.tsx` + 列表 `index.tsx` + 草稿本地存储 `draft-store.ts` + 分享弹窗 `share-dialog.tsx` + `notes.css`）。
- 公开分享页：`frontend/app/notes/shared/[token]/page.tsx`（独立路由，无需登录态）。
- nginx 对 `/notes/shared/` 开启 `proxy_cache`（公开可缓存），对 `/notes`（鉴权端点）不缓存。

## 依赖

- **MongoDB 必须启用**：正文与修订均存 Mongo，`MILVUS__ENABLED` 之外需确保 Mongo 连接。Mongo 未连接时，创建/更新会抛 `RuntimeError`，读取降级为空。
- 表结构在 `app/system.sql`（`notes` / `note_anchors` / `note_shares`）。

## 测试

```bash
python -m pytest app/test/test_notes_service.py app/test/test_notes_markdown_safety.py -q
```

- `test_notes_service.py`：CRUD / 锚点 / 修订 / 分享 / 并发冲突 / 权限。
- `test_notes_markdown_safety.py`：消毒策略（脚本注入、危险 URL、保留合法 Markdown 语法）。
