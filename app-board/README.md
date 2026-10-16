# app-board —— 思维导图 / 白板存储服务（Go + Gin）

> 板内容（mindmap = simple-mind-map 树 JSON / whiteboard = Excalidraw scene JSON）的存储权威：
> CRUD + 乐观锁（expected_version）+ 软删 + 置顶。AI（board agent / 补全智能体）**不直连本服务**，
> 一律经 mcp/app-board-mcp → APISIX key-auth `/internal/board/*`。

## 端口与路由

| 路由 | 说明 |
|------|------|
| `/board/*` | CRUD / 树导航（view=children/siblings/parent/subtree/search）/ 置顶（`requireXUid` 网关注入头） |
| `/health` | 探活 |

无宿主端口映射（仅 mind-base-net 内网，经 APISIX 访问；容器内 :8004）。HTTPS-only：
启动自动生成 dev-CA + 叶子证书并持久化（cert_dir），**运行期每日巡检自动重签/热切换**；
APISIX 信任其中的 dev-ca.crt（首次生成后需 `docker compose restart apisix` 重载 bundle）。

## 数据所有权

MySQL bilirag `board` schema（服务自建，禁 ALTER）+ Mongo `MindBase.board_documents`。
Redis（db /2）只做列表/详情读缓存（cache-aside；写路径直落 MySQL），故障自动降级直查。

## 运行

```bash
go run ./app-board               # 依赖 MySQL + Mongo + Redis
docker compose up -d app-board   # compose profile ["", "board", "full"]
```

配置入口 `default.yaml`（`APPBOARD__` env 覆盖）。规范详见 AGENTS.md §2.11、docs/app-board.md。
