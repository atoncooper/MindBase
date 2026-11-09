# app-content-mcp —— 内容域 MCP Server（Go + mcp-go）

> 由原三个 MCP server（app-board-mcp / app-note-mcp / app-quiz-mcp）合并而来：
> **一个进程 / 一个端口 / 一个 `/mcp` 端点**，把 app-content（board + note + quiz）的能力以
> **12 个 MCP 工具**暴露给任意 MCP 宿主（app-ts agent / ZCode / Claude 等）。
> 工具名、参数、返回文案与合并前完全一致，因此 agent prompt 契约与 MCP 协议零改动。

## 工具面

| 域 | 工具 |
|----|------|
| board | `list_boards`（标题搜索，跨页扫描上限 1000）/ `get_board` / `create_board` / `update_board`（乐观锁）/ `delete_board`（软删）/ `pin_board` |
| note | `save_note` / `list_notes` / `get_note` / `update_note` |
| quiz | `save_quiz` / `save_grading` |

另有 board 域 Resources（`board://{uuid}` 模板 + 请求时动态 `resources/list`）与
Prompts（`organize_into_board` / `review_board` / `board_to_outline`）。

## 传输与端口

- **streamable-http**：容器/回环 `:8019` 的 `/mcp`（app-ts 经 compose 内网直连 `http://app-content-mcp:8019/mcp）；
  `/health` 为免认证探针。也支持 stdio（`--transport stdio`，本地宿主用）。
- 宿主映射仅回环：`127.0.0.1:${APP_CONTENT_MCP_PORT:-8019}:8019`。
- **双模式鉴权**（`serve.Auth`，http 模式凭证双缺则拒绝启动）：
  - 服务模式：`apikey: <SERVICE_API_KEY>` + 每请求 `X-Uid`（app-ts agent；uid 来自已认证会话）；
  - Bearer 模式：`Authorization: Bearer <AUTH_TOKEN>` + 配置固定 uid（外部 MCP 宿主）。
  - **两种模式下 uid 都不出现在 LLM 可写参数里**（红线）。
- 防护：Origin 白名单（DNS rebinding 防御）+ 令牌桶限流（10 rps / burst 20）+ 并发上限（8，503）
  + body 上限（10MB，413）+ request-id 贯穿 + 结构化访问日志。
- TLS 可选（`CONTENTMCP__SERVER__TLS__ENABLED`，默认关 = 回环 http）：证书由 cert-gen 签发到
  `app-go/app-content-mcp/certs`（explicit 模式加载，rotator 每日巡检）。

## 链路

```
MCP 宿主 / app-ts ──streamable-http──► app-content-mcp:8019/mcp
      └─ upstream（apikey + X-Uid）──► APISIX key-auth
            ├─ /internal/board/*  ──► app-content（board 面）
            ├─ /internal/note/*   ──► app-content（note 面）
            └─ /internal/quiz/*   ──► app-content（quiz 面）
```

## 代码结构（按 MCP 原语）

```
app-go/app-content-mcp/
├── main.go                  # 进程入口：transport/HTTP 加固/TLS/优雅关停
├── internal/
│   ├── bootstrap/           # 组合根：capability 声明 + 三原语注册
│   ├── mcp/tools/           # Tools：board.go / note.go / quiz.go（12 个工具）
│   ├── mcp/resources/       # Resources：board.go（board://{uuid} 模板 + 动态 list）
│   ├── mcp/prompts/         # Prompts：board.go（3 个模板）
│   ├── mcp/kit/             # 原语无关：wrap / 结果构造 / 未配置守卫
│   ├── upstream/{board,note,quiz}/  # 各域 HTTP 客户端（经 APISIX internal 路由）
│   ├── serve/               # HTTP 加固链（鉴权/限流/并发/body/Origin/request-id）
│   └── {config,identity,logger,certs}/  # 平台基础设施
├── tests/                   # 合并级黑盒 smoke（12 工具 + 3 prompts）
└── Dockerfile
```

> MCP 标准约束的是**协议面**（capabilities 与 JSON-RPC 方法），不是目录结构；这里按 Tools / Resources / Prompts
> 三个原语分包，是为了让「服务暴露了什么」一眼可见。传输/分页/取消/会话由 mcp-go 实现。

## 运行

```bash
go run .
docker compose up -d app-content-mcp   # 默认 profile 启动（content-mcp / full 亦可）
```

## 配置

环境变量前缀 `CONTENTMCP__`（`__` 表示嵌套），默认值内置于 `internal/config`：
`UPSTREAM__BASE_URL` / `UPSTREAM__API_KEY` / `UPSTREAM__UID`；
`SERVER__TRANSPORT|HTTP_ADDR|AUTH_TOKEN|SERVICE_API_KEY|ALLOWED_ORIGINS|RATE_LIMIT_RPS|RATE_LIMIT_BURST|MAX_BODY_BYTES|MAX_INFLIGHT|TLS__*`；
`LOG__LEVEL|FORMAT|OUTPUT|FILE*`；`SERVER__RATE_LIMIT_PER_UID_RPS/_BURST` 为鉴权后的按身份限流（0=关闭）。另有 `CONTENTMCP__SERVER__BEARER_ALLOWED_TOOLS`（可选）：把外部 Bearer
token 限定在工具子集（空=全部 12 个；服务模式不受限）。密钥只进 `.env`，普通配置进 compose/yaml。

规范见 AGENTS.md §2.11 与 [docs/app-content-mcp.md](../../docs/app-content-mcp.md)。测试全部在 `tests/`（`package tests` 黑盒，经 in-process MCP client 调用三原语）。
