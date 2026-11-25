# 用户 MCP 连接

> 每个用户自己添加第三方 MCP Server，Harness 只在该用户的会话中调用。
> 页面入口：聊天侧栏左下角「MCP 接入」→ /mcp
>
> **归属**：连接（地址 + API Key）是用户配置，存储在 **app-user 的设置域**
> （表 `user_mcp_servers`），与 Coding Plan 同一套所有权规则；**app-ts 不落库**，
> 只负责 MCP 协议（tools/list、tools/call）。

## 数据模型（app-user，settings 域）

- 每个连接绑定 uid，名称在用户内唯一（`uk_ums_uid_name`）
- 凭据是**单个 API Key**（不是自由 JSON headers）：
  - `auth_kind=none`：无鉴权
  - `bearer`：请求带 `Authorization: Bearer <key>`
  - `header`：请求带 `<auth_header>: <key>`（如 `X-API-Key`）
- API Key 用 **AES-256-GCM**（`SECURITY__API_KEY_ENCRYPTION_KEY`，与 Coding Plan 共用）
  加密后写入 `api_key_enc`；用户面 API 只返回 `api_key_masked`，永不回显明文
- `tools_json` / `last_error` 是 app-ts 探测 tools/list 后的回写缓存（供设置页与聊天目录读取）
- 默认每个用户最多 10 个连接（`settings.mcp.max_servers`）

## API

### 用户面（APISIX `mcp_connections_user` → app-user settings 8015，forward-auth 注入 X-Uid）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /settings/mcp/servers | 当前用户的连接（掩码 Key + 已发现工具） |
| POST | /settings/mcp/servers | 新建连接（只存配置，不探测） |
| PATCH | /settings/mcp/servers/{id} | 改名/改地址/改鉴权；空 `api_key` 表示保留原 Key |
| DELETE | /settings/mcp/servers/{id} | 删除 |

新建请求（API Key 只在写入时出现一次）：

~~~json
{
  "name": "github",
  "url": "https://mcp.example.com/mcp",
  "auth_kind": "bearer",
  "api_key": "ghp_xxx"
}
~~~

`auth_kind=header` 时额外传 `auth_header`（例如 `"X-API-Key"`）。

### 内部 M2M（APISIX `mcp_connections_internal` → app-user 8015，key-auth）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /internal/settings/mcp/{uid} | 该用户全部连接 + **解密后的 API Key**（唯一明文面） |
| PATCH | /internal/settings/mcp/{uid}/{id}/discovery | app-ts 回写 `tools` / `last_error` |

### MCP 协议面（app-ts，仅探测）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /mcp/servers/{id}/discover | 读取连接 → tools/list → 回写 app-user → 返回工具目录 |

## OAuth 2.1（Figma / Notion 等 OAuth-only Server）

API Key / 自定义 Header 只能连**接受静态 token** 的 Server。Figma 远程 MCP
（`https://mcp.figma.com/mcp`）要求 OAuth（scope `mcp:connect`），个人 token 无效，
因此连接支持 OAuth 2.1：

1. 设置页把鉴权方式选为「OAuth 授权」，保存后自动跳转第三方授权页。
2. 服务端按 RFC 9728 / RFC 8414 发现元数据，做**动态客户端注册**（DCR）和 PKCE(S256)，
   把一次性 state + code_verifier + 客户端凭据写入 `user_mcp_oauth_states`（10 分钟 TTL）。
3. 第三方回调 `GET /settings/mcp/oauth/callback`（公开路由）消费 state、换取 token，
   写 `user_mcp_oauth`（AES 加密），并把连接的 `auth_kind` 置为 `oauth`。
4. app-ts 调用时带 `Authorization: Bearer <access_token>`；临近过期（60s）或 refresh 失败时
   经内部面 `POST /internal/settings/mcp/{uid}/{id}/refresh` 刷新。

回调地址是部署相关的，必须在 app-user `default.yaml` 配置成**浏览器可达**的地址：

~~~yaml
settings:
  mcp:
    oauth:
      callback_url: "https://localhost/mindbase/api/v1/settings/mcp/oauth/callback"
      frontend_url: "https://localhost/mcp"
      allow_private_hosts: false   # 仅本机/内网 provider 才开
      timeout_ms: 10000
~~~

> 生产环境把两个 URL 换成公网域名；DCR 会把这个 callback 注册给 provider，
> 改地址后已有连接需要重新授权。全部 OAuth 端点（含 DCR/token）都做 SSRF 校验。

### 已知限制：Figma 远程 MCP 拒绝第三方客户端注册

Figma 的 `https://api.figma.com/v1/oauth/mcp/register` 对 `client_name` 做了白名单
（Claude Code / Copilot CLI 等官方客户端），任何其它客户端都会收到 **403**，因此
**Figma 远程 MCP（mcp.figma.com）无法由第三方产品接入**——不是本实现的 bug。
Notion、Linear 等允许 DCR 的服务可以正常走上面的流程（已实测 201 + 授权 URL）。

Figma 目前只有两条路：

1. **Figma 桌面端本地 MCP**：`http://127.0.0.1:3845/mcp`（无需鉴权）。容器里要写成
   `http://host.docker.internal:3845/mcp`，并只在本地开发时打开
   `app-ts userMcp.allowPrivateHosts`；生产不能开（SSRF）。
2. 向 Figma 申请把 MindBase 加入白名单。

## 代码位置

- **app-user（存储 / CRUD / 加密）**：`internal/router/settings/mcp.go`、`internal/service/settings/mcp.go`、
  `internal/repo/settings/mcp.go`、表 `user_mcp_servers`
- **app-ts（仅协议桥，无持久化）**：`src/mcp/user-connections.ts`（`UserMcpBridge`：SSRF 校验 + tools/list + tools/call）
  + `src/clients/app-user-settings-mcp-client.ts`（内部 M2M 读取 + discovery 回写）

> `app-ts/src/services/` 不再有 user-mcp：设置域的业务在 app-user，app-ts 只保留 MCP 协议本身。

## Agent 调用

主 Agent 每轮读取当前用户 MCP 目录（app-ts 缓存 30s，`userMcp.cacheTtlMs`），注入系统提示词：

~~~text
MCP server github：
- search_repositories
- get_file_contents

调用方式：mcp_user_call({ server, tool, arguments })
~~~

实际执行：

~~~text
mcp_user_call
  → uid 来自 ToolRunContext（永不出现在 LLM 参数里）
  → app-ts 经内部 M2M 读取该 uid 的连接（解密 Key）
  → SSRF 校验（私网/回环/链路本地默认拒绝）
  → 新建短连接 McpClient
  → 调用第三方 MCP
  → 结果截断后返回模型
~~~

聊天执行过程显示 MCP · server / tool、MCP 参数、MCP 返回。

## 服务端配置

app-user（`settings` 段，CRUD + 存储）：

~~~yaml
mcp:
  enabled: true
  max_servers: 10
~~~

app-ts（`userMcp` 段，仅协议/传输）：

~~~yaml
userMcp:
  enabled: true          # 是否注册 mcp_user_call
  timeoutMs: 20000
  maxContentChars: 8000
  cacheTtlMs: 30000      # 读取 app-user 连接的缓存 TTL
  allowPrivateHosts: false
~~~

生产必须设置 `SECURITY__API_KEY_ENCRYPTION_KEY`（32 字节 base64）；没有 key 时保存
带 API Key 的连接会失败（无鉴权连接仍可用）。

`allowPrivateHosts` 默认 false，阻止用户把 MCP 指向 app-user、APISIX、MySQL 等内网地址（SSRF）。
本地连接 localhost / host.docker.internal 时才临时打开。

## 安全边界

- 用户只能读写自己的连接（所有 SQL 以 uid 过滤）
- 每次调用校验 uid（来自网关注入的 X-Uid，不来自模型参数）
- API Key 加密落库，用户面 API 永不回显；明文只在 app-user 内部 M2M 面出现
- 默认阻断私网/回环/链路本地地址，并做 DNS 解析后的私网校验（app-ts 连接前）
- MCP 返回内容截断后进入模型上下文（`maxContentChars`）
- 关闭开关：app-user `settings.mcp.enabled=false` 或 app-ts `userMcp.enabled=false`

## 与旧实现的差异（2026-11）

旧实现把连接存在 app-ts 的 MongoDB，且鉴权让用户手写 JSON headers。现已改为：

- 存储/CRUD 归 **app-user settings 域**（`user_mcp_servers`），app-ts 只读内部 M2M 面
- 凭据模型改为 **API Key**（none / bearer / header），前端不再出现 JSON 输入框

旧数据无需迁移：该功能此前未提交、未上线（开发期数据可直接删除）。
