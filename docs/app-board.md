# app-board — 思维导图 / 白板内容存储服务

> 独立 Go 微服务（Gin + GORM + Mongo），为前端「思维导图」页面提供板（board）的存储、乐观并发与 pin 能力。白板（Excalidraw）存储契约已就绪，编辑器 P3 接入。

## 定位

| 维度 | 说明 |
|------|------|
| 角色 | 板内容存储：CRUD + 版本乐观锁 + 置顶。无业务逻辑，不理解编辑器 JSON 内容 |
| 技术栈 | Go 1.25 + Gin v1.12 + GORM（MySQL）+ mongo-driver v2 + go-redis v9（可选缓存） |
| 端口 | 8004，**HTTPS-only**；容器内仅经 APISIX 可达（compose 不映射宿主端口） |
| 鉴权 | 信任 APISIX forward-auth 注入的 `X-Uid`（非空正整数即放行），不自验 bili_session |
| 存储 | 元数据 MySQL `mind_base`.`board`（自有表，AutoMigrate）；正文 Mongo `MindBase`.`board_documents` |
| 内容 | 编辑器 JSON 原文（simple-mind-map 树 / Excalidraw 场景），上限 8MB |

## API

Base path：`/board`（经 APISIX `/board/*` 路由）。错误体 `{"detail": ...}`，500 附带 `request_id`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 探活 `{"status":"healthy","service":"app-board"}` |
| GET | `/board/boards` | 列表（query：`kind`=`mindmap`\|`whiteboard`\|缺省全部，`page`、`page_size`） |
| POST | `/board/boards` | 创建 `{title?, kind?, content?}`（kind 默认 `mindmap`）→ 201 |
| GET | `/board/boards/:uuid` | 详情，响应头 `ETag: <version>` |
| PUT | `/board/boards/:uuid` | 更新，**必须带 `If-Match: <version>`**：缺失 → 428，不匹配 → 409 |
| DELETE | `/board/boards/:uuid` | 软删除 → 204 |
| PATCH | `/board/boards/:uuid/pin` | `{isPinned: bool}` |

并发模型：`version` 是乐观锁计数器，更新时 `If-Match` 比对后递增；所有查询按 uid 过滤（非本人与不存在一律 404）。写路径是 MySQL 元数据 + Mongo 正文的**双存储提交**，Mongo 失败自动回滚版本。

## 缓存（Redis，可选）

cache-aside，只缓存读：`board:detail:{uid}:{uuid}` 与 `board:list:{uid}:{kind|all}:{page}:{pageSize}`（>1MB 的详情不缓存）。写直落 MySQL 并立即失效相关键；TTL（默认 300s）只是兜底。`APPBOARD__REDIS__URL` 留空则用 NoopCache；Redis 故障降级为缓存 miss，不影响正确性。

## TLS

默认 `server.tls.enabled: true`（HTTPS-only），两种模式：

- **自动（默认）**：cert/key 留空 → 自动生成持久化开发 CA（`dev-ca.crt/key`，10 年）+ 叶子证书（`server.crt/key`，SAN 覆盖 localhost/app-board 等，825 天）。Rotator 每日巡检：余量 <30 天或文件丢失自动重签并经 `GetCertificate` 热切换。
- **显式**：`APPBOARD__SERVER__TLS__CERT/KEY` 指定文件（正式 CA 上线后用）。

APISIX 侧挂载 `app-board/certs` 目录，把 `dev-ca.crt` 追加进信任锚 bundle（`apisix.ssl.ssl_trusted_certificate`，**替换**默认池所以同时并入系统 CA）。冷启动顺序注意：首次先起 app-board 再 `docker compose restart apisix`。

> APISIX 3.11 限制：HTTP 上游无法做证书校验（`tls.verify` 仅支持 kafka），因此健康检查 `https_verify_certificate: false`（只加密不验身份）；数据面节点名 `app-board` 充当 SNI 命中叶子证书 SAN。

## 配置

三层：嵌入 `default.yaml` ← `APPBOARD__` 环境变量（双下划线嵌套，最高优先级）；`main.go` 顺带加载项目根 `.env`。密钥类（`rdbms.url`、`mongo.uri`）必须 env 注入，缺省拒绝启动。

```bash
APPBOARD__RDBMS__URL=mysql+aiomysql://mind_base:mind-base@mysql:3306/mind_base
APPBOARD__MONGO__URI=mongodb://admin:mind-base@mongo:27017/?authSource=admin
APPBOARD__MONGO__DB_NAME=MindBase
APPBOARD__REDIS__URL=redis://:mind-base@redis:6379/2   # 留空=禁用缓存
APPBOARD__SERVER__TLS__CERT_DIR=/app/certs
APPBOARD__SECURITY__CORS__ALLOW_ORIGINS=...            # 默认含 localhost:3000 与 https://localhost
APPBOARD__LOG__LEVEL / _FORMAT / _OUTPUT / _FILE__*
```

完整清单见 `.env.example` 的 app-board 段与 `app-board/default.yaml`。

## 中间件

- `X-Request-Id`：透传（APISIX request-id 插件注入）或自生成，回写响应头并贯穿 slog
- CORS：白名单反射 + credentials，允许头含 `Authorization, Content-Type, If-Match, X-Request-Id, X-Requested-With`
- Body 限制 9MB（8MB 内容 + JSON envelope 余量）；Server 超时 read 60s / write 120s / idle 120s
- `SetTrustedProxies(nil)`：不信任 XFF

## 启动

```bash
# 与主栈一起（默认 profile 已包含）
docker compose up -d app-board

# 本地运行（从项目根）
go run ./app-board

# 测试（无外部依赖，内存 fake）
cd app-board && go test ./...
```

## 前端接入

`frontendv2/lib/api/boards.ts` 封装上述 API（`If-Match` 乐观锁，409 → `BoardConflictError`），`lib/board-store.ts` 是桌面端（Tauri）`lib/mindmap.ts` 的 Web 版存储桥——对编辑器组件导出同一套契约（saveMindMap / getMindMap / 列表 / 图标包 / 模板 / 导出），桌面编辑器因此原样移植：图标包/模板/快照落 localStorage，导出走浏览器下载，文档内容走 boards API（409 自动重试一次，last-write-wins）。

入口：`/mindmap` 页面（Drive 风格列表 + 编辑器，800ms 防抖自动保存 + Ctrl+S）。

## 约束与红线

- `board` 表归 app-board 所有（AutoMigrate），主后端勿动该表
- 正文必须进 Mongo，MySQL 只存元数据（与笔记的分离存储同构）
- 不做 nginx 侧缓存与本地 L1 缓存（内容随编辑高频变化）
- 版本号是并发权威，任何写路径不得绕过 `If-Match`
