# app-board-mcp — 思维导图 / 白板 MCP server

> 仓库第一个 MCP（Model Context Protocol）server：把 app-board 的板（board）能力以标准 MCP 工具暴露给任意 MCP 宿主（ZCode / Claude 等 Agent），让 Agent 可以列出、读取、创建、更新、删除、置顶思维导图与白板。

## 定位

| 维度 | 说明 |
|------|------|
| 角色 | app-board 的 MCP 适配层：6 个工具 + 1 个资源模板（动态列表）+ 3 个 prompts，薄映射，无业务逻辑 |
| 技术栈 | Go 1.25 + [mcp-go](https://github.com/mark3labs/mcp-go) v1.1.0 + 官方 uuid/godotenv |
| 传输 | `--transport stdio`（默认，本地 MCP 宿主直拉）或 `--transport http`（streamable-http，容器部署；MCP 端点 `/mcp`，另有 `GET /health`） |
| 端口 | 容器形态仅回环 `127.0.0.1:8005` |
| 鉴权 | 出站经 APISIX key-auth 内部路由 `/internal/board/*`（`apikey: APISIX_CONSUMER_KEY`）；身份为配置固定的 `X-Uid` |
| 上游 | app-board（8004，HTTPS-only，仅 compose 网络内可达） |

**身份模型（安全边界）**：uid 来自配置 `BOARDMCP__UPSTREAM__UID`，**工具参数不含 uid**——Agent 无论被怎样提示，都只能操作该 uid 名下的板子。这与 app-task「uid 放请求体、调用方可信」的 M2M 惯例一致，key-auth 持有者即受信内部服务。

## 认证与限流

**MCP 端点（8005 /mcp，http 传输）**——回环绑定之外再加四层，按请求顺序：

| 层 | 默认 | 说明 |
|----|------|------|
| 限流 | 10 rps / burst 20 | token bucket，超限 429 + Retry-After（`BOARDMCP__SERVER__RATE_LIMIT_RPS/_BURST`） |
| 认证 | **必填** | `Authorization: Bearer <BOARD_MCP_AUTH_TOKEN>`，常量时间比较；缺失/错误 401。**http 传输缺 token 直接拒启（fail closed）**；stdio 传输不需要（进程级信任） |
| Origin 校验 | 拒绝所有 | 浏览器必带 Origin 头而 MCP 宿主不带——非白名单 Origin 一律 403（MCP 规范的 DNS rebinding 防御）。Web 版 MCP 客户端出现时用 `BOARDMCP__SERVER__ALLOWED_ORIGINS` 开白名单 |
| 并发上限 | 8 | 超限 503 + Retry-After（`BOARDMCP__SERVER__MAX_INFLIGHT`）；另有 body 上限 10MB（`BOARDMCP__SERVER__MAX_BODY_BYTES`，413） |

**上游（MCP server → APISIX → app-board）**：key-auth（apikey）+ X-Uid 属主过滤之外，`board_internal` 路由加 `limit-req`（每调用方 20 rps + burst 10，超限 429）——网关侧兜底，防止任何 key-auth 持有者打爆 app-board；同时 MCP 工具层每次调用最多放大 10 次（search 扫描上限），两层相乘有界。

**profiles 收紧**：compose 服务不再随默认 profile 启动（`profiles: ["board", "full"]`）——显式拉起时才需要配 token/uid，避免默认栈里出现一个未配置凭据的可变更存储端点。

## TLS

默认**关**（回环 http 是本机部署的既定姿态，token + Origin + 限流已覆盖本地威胁面）；跨机 MCP 宿主、放宽回环绑定、或宿主强制 https 时启用。实现移植自 app-board 的 `internal/tls`（现 `internal/certs`），策略一致：

| 模式 | 触发条件 | 行为 |
|------|---------|------|
| 自动（默认） | ENABLED=true 且 CERT_FILE/KEY_FILE 双空 | 首次启动生成持久 dev-CA（10 年）+ 叶子（ECDSA P-256 / 825 天，SAN 含 localhost/127.0.0.1/::1/容器名），每日巡检：<30 天自动重签、文件丢失自愈、热切换不重启 |
| 显式 | CERT_FILE/KEY_FILE 成对提供 | 直接加载（生产 CA 签发证书）；只给一个=拒启；临近过期仅告警（续期外部负责） |

启用步骤（compose）：

```bash
# 1. .env 置 BOARD_MCP_TLS_ENABLED=true 后
docker compose --profile board up -d --force-recreate app-board-mcp
# 2. CA 自动生成在 ./mcp/app-board-mcp/certs/dev-ca.crt
# 3. MCP 宿主侧信任 CA：
#    - Node 系宿主（默认不读系统证书库）：环境变量 NODE_EXTRA_CA_CERTS=<dev-ca.crt 绝对路径>
#    - 系统库宿主：把 dev-ca.crt 装入系统"受信任的根证书颁发机构"
# 4. 宿主 URL 改为 https://127.0.0.1:8005/mcp（Authorization 头不变）
```

握手基线 TLS 1.2+；证书协商走 `tls.Config.GetCertificate`（轮换热生效，无需重启）。stdio 传输无网络，TLS 不适用。

> **Windows 宿主注意**：走 schannel 的客户端（Windows 自带 curl、PowerShell Invoke-WebRequest 等）会对无 CRL 的自签链报 `CERT_TRUST_REVOCATION_STATUS_UNKNOWN`——证书本身有效，需 `curl --ssl-no-revoke` 或客户端关闭吊销检查；Node 系宿主（用 NODE_EXTRA_CA_CERTS）与 OpenSSL 系不受影响。已实测：CA 严格校验（非 -k）下 health 200、initialize 200、无 token 401。

## 服务模式（主 app backend 接入）

除外部宿主的 Bearer token 外，MCP server 支持受信内部调用方（主 app backend 的 board agent / 补全）：

| 项 | 值 |
|----|----|
| 凭证 | `apikey: <APISIX_CONSUMER_KEY>`（复用 consumer key，无新密钥）+ 每请求 `X-Uid: <uid>` |
| 身份 | X-Uid 即本次操作的板子属主（来自后端已认证会话）；**LLM 可写参数中永远不含 uid** |
| 端点 | backend 经 compose 内网直连 `http://app-board-mcp:8005/mcp`（容器互访不受宿主回环绑定限制）；配置 `BOARDMCP__SERVER__SERVICE_API_KEY` |
| 链路 | backend → app-board-mcp:8005 → APISIX `/internal/board/*`（key-auth + limit-req）→ app-board |

## 链路

```
MCP 宿主(ZCode/Claude) --streamable-http--> 127.0.0.1:8005 /mcp (app-board-mcp 容器)
    -- http://apisix:9080/internal/board/*  头: apikey + X-Uid + X-Request-Id -->
APISIX board_internal(key-auth + proxy-rewrite 去 /internal 前缀)
    -- https --> app-board:8004 /board/*（按 X-Uid 做属主过滤）
```

## MCP 工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `list_boards` | `kind?`、`page?`、`page_size?`、`search?` | 元数据列表；`search` 为标题子串过滤（忽略大小写，跨页扫描上限 1000 条后置 `truncated:true`） |
| `get_board` | `board_uuid` | 元数据 + 正文（content 解析为 JSON 对象返回），带乐观锁 `version` |
| `create_board` | `title`、`kind?`、`content?` | kind 默认 `mindmap`；content 可传对象或 JSON 字符串，原样存储 |
| `update_board` | `board_uuid`、`expected_version?`、`title?`、`content?`、`is_pinned?` | 至少一个字段；`expected_version` 省略时自动锁定最新版本（末写者胜，输出注明）；409 冲突时返回最新版本号 |
| `delete_board` | `board_uuid` | 软删除（服务端 Mongo 正文保留备人工恢复） |
| `pin_board` | `board_uuid`、`is_pinned` | 走 PATCH，不递增 version |

**内容格式**（工具描述内嵌同样说明）：
- mindmap = simple-mind-map 树：`{"root":{"data":{"text":"中心主题"},"children":[{"data":{"text":"分支"},"children":[]}}]}`
- whiteboard = Excalidraw scene JSON（app-board 存储契约已就绪，编辑器 P3 接入）
- 单板正文上限 8MB（超限 413，错误消息已注明）

## Resources

`board://{uuid}` 资源模板：宿主可直接 `resources/read` 读取一块板子的完整文档（宿主控制的上下文，与工具互补——发现走 resources/list 或 list_boards，读取走资源）。

- **内容**：包装 JSON（mimeType `application/json`）`{uuid,title,kind,version,isPinned,createdAt,updatedAt,content:<解析后的文档对象>}`——version 随载荷给出，可直接用于 update_board 乐观锁
- **动态列表**：`resources/list` 经 `OnAfterListResources` 钩子在**请求时**分页拉取上游（上限 1000 条，截断时末条 description 标注"更多请用 list_boards"）——零轮询、零陈旧快照；每次 list 最多 10 次上游调用，受端点限流约束
- **能力**：`subscribe=false`（app-board 无变更推送源）、`listChanged=false`（注册集不变，列表靠请求时刷新）——均属红线
- 大文档（上限 8MB）整份进入宿主上下文，宿主/用户自行斟酌

## Prompts

3 个引导式任务模板（宿主侧表现为斜杠命令；渲染为单条 user 消息，纯模板不调上游，工具调用由 LLM 执行）：

| 名称 | 参数 | 行为 |
|---|---|---|
| `organize_into_board` | `text`（必填）、`title?`、`kind?` | 引导 LLM 把文本层级化后调 `create_board` 建板，报告 uuid/标题/一级分支 |
| `review_board` | `board_uuid`（必填） | 先 `get_board`，按 5 维体检（深度失衡/同级重复/缺失叶子/节点过载/层级过深），输出问题清单+改进文档 JSON；**明确先给方案、用户确认后才调 update_board** |
| `board_to_outline` | `board_uuid`（必填）、`depth?` | 先 `get_board`，按 # 层级输出 markdown 大纲 |

## 配置

env（前缀 `BOARDMCP__`，双下划线嵌套；godotenv 自工作目录向上找根 `.env`，进程 env 优先）：

| 键 | 默认 | 说明 |
|----|------|------|
| `BOARDMCP__UPSTREAM__BASE_URL` | `http://127.0.0.1:9080` | APISIX 网关基址（compose 内为 `http://apisix:9080`） |
| `BOARDMCP__UPSTREAM__API_KEY` | 空 | key-auth consumer key（= `APISIX_CONSUMER_KEY`，密钥走 .env） |
| `BOARDMCP__UPSTREAM__UID` | 空 | 以该 uid 访问 app-board；**空=未配置，容器照常启动但工具调用报错** |
| `BOARDMCP__SERVER__TRANSPORT` | `stdio` | `stdio` \| `http` |
| `BOARDMCP__SERVER__HTTP_ADDR` | `:8005` | http 传输监听地址 |
| `BOARDMCP__LOG__LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `BOARDMCP__LOG__FORMAT` | `json` | `json` \| `text` |
| `BOARDMCP__LOG__OUTPUT` | `stderr` | `stderr` \| `stdout` \| `file` \| `both`（both=stdout+file） |
| `BOARDMCP__LOG__FILE` | `/app/logs/app-board-mcp.log` | 文件路径（Output 含 file 时生效，lumberjack 轮转） |
| `BOARDMCP__LOG__FILE_MAX_SIZE` / `_MAX_BACKUPS` / `_MAX_AGE` / `_COMPRESS` | 100 / 7 / 30 / false | 轮转参数 |
| `BOARDMCP__SERVER__TLS__ENABLED` | `false` | http 传输 TLS 开关（stdio 无意义） |
| `BOARDMCP__SERVER__TLS__CERT_DIR` | `/app/certs` | 自动模式证书目录（dev-ca + 叶子持久化） |
| `BOARDMCP__SERVER__TLS__CERT_FILE` / `_KEY_FILE` | 空 | 显式证书模式：成对提供则加载（生产 CA 签发）；**成对留空=自动生成**，只给一个=启动报错 |

命令行 `--transport` / `--http-addr` 可覆盖同名 env（容器 ENTRYPOINT 已固定为 http）。

## 日志

结构化 slog（JSON），消息带 `[BOARDMCP]` 前缀，与 app-board 的 logger 同一套约定（`internal/logger` 同名包）：

| 维度 | 说明 |
|------|------|
| 传输约束 | **stdio 模式默认/强制 stderr**（stdout 是 MCP JSON-RPC 协议通道）；误配 `OUTPUT=stdout/both` 时启动期告警并自动回落 stderr |
| 请求级 trace | X-Request-Id：http 模式由中间件注入（认入站头，回显响应头，截断 64 字符）；stdio 模式每次工具调用生成；同一 id 贯穿 **access log → 工具调用日志 → 上游 X-Request-Id → app-board 日志**，一次 Agent 动作一条 trace |
| access log | http 模式每请求一行（method/path/status/size/latency/request_id），status≥500 error、≥400 warn、否则 info |
| 工具调用日志 | 每次调用一行：tool、board_uuid/kind/分页/置顶等安全参数、`title_len`/`content_bytes`（**只记长度不记内容**——文档正文与标题文本不落日志）、elapsed；成功 info、业务失败 warn、handler 异常 error |
| 上游调用日志 | 每次网关调用一行：4xx warn（Agent 可自纠）、5xx/网络错误 error、成功 debug（level=info 时静默） |
| panic | 工具 handler panic 记 error + 堆栈，转为工具错误结果返回（不炸 MCP 会话） |
| 排查 | compose 卷 `app_board_mcp_logs` → `/app/logs/app-board-mcp.log`；docker logs 看 stdout 同样内容 |

## 启动

依赖走标准 Go Modules（`go.mod`/`go.sum`，Dockerfile 内 `go mod download`，GOPROXY=goproxy.cn + direct 回落）。若构建时模块下载被网络重置，可用宿主代理构建：

```bash
docker compose build --build-arg HTTP_PROXY=http://host.docker.internal:10808 \
                     --build-arg HTTPS_PROXY=http://host.docker.internal:10808 app-board-mcp
```

```bash
# 与主栈一起（默认 profile 已包含；先在 .env 填 BOARD_MCP_UID）
docker compose up -d app-board-mcp
# 或随 board profile
docker compose --profile board up -d app-board-mcp

# 本地运行（stdio；宿主机无法直达 compose 网络内的 apisix，
# 需自行打通网关访问，如临时端口映射——默认部署形态是上面的容器 http）
cd mcp/app-board-mcp && go run . --transport http --http-addr :8005
```

## MCP 宿主注册

ZCode / Claude 等支持远程 MCP 的宿主（streamable-http，带认证头）：

```json
{
  "mcpServers": {
    "app-board": {
      "url": "http://127.0.0.1:8005/mcp",
      "headers": { "Authorization": "Bearer <BOARD_MCP_AUTH_TOKEN>" }
    }
  }
}
```

stdio 传输的宿主（本地直跑二进制时）：

```json
{
  "mcpServers": {
    "app-board": {
      "command": "go",
      "args": ["run", "."],
      "cwd": "mcp/app-board-mcp",
      "env": {
        "BOARDMCP__UPSTREAM__BASE_URL": "http://127.0.0.1:9080",
        "BOARDMCP__UPSTREAM__API_KEY": "<APISIX_CONSUMER_KEY>",
        "BOARDMCP__UPSTREAM__UID": "<uid>"
      }
    }
  }
}
```

> stdio 模式日志强制走 stderr——stdout 是 JSON-RPC 协议通道，这是 MCP 约定。

## 测试

```bash
cd mcp/app-board-mcp
go vet ./... && go test ./...
```

- `internal/upstream`：httptest 伪造 app-board，覆盖头部注入（apikey/X-Uid/X-Request-Id）、If-Match、content 两种形态原样转发、错误信封解析
- `internal/tools`：6 工具 happy path + 校验失败 + 自动锁版本 + 409 冲突提示 + search 跨页扫描截断 + 未配置守卫

冒烟（compose 在跑；APISIX/app-board 无宿主端口，从 backend 容器内验证，apikey 取 .env 的 `APISIX_CONSUMER_KEY`）：

```bash
# 1. MCP server 探活（宿主可达，回环映射）
curl http://127.0.0.1:8005/health

# 2. key-auth：缺 apikey 应 401；带 apikey + X-Uid 应 200 返回板列表
docker compose exec -T backend python -c "
import os, urllib.request, urllib.error
key = os.environ.get('APISIX_CONSUMER_KEY', '')
def probe(headers):
    req = urllib.request.Request('http://apisix:9080/internal/board/boards?page=1&page_size=5', headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as r: return r.status
    except urllib.error.HTTPError as e: return e.code
print('no-key  ->', probe({'X-Uid': '1'}))            # 401
print('with-key->', probe({'X-Uid': '1', 'apikey': key}))  # 200
"

# 3. MCP 握手（JSON-RPC initialize → 响应头 mcp-session-id → tools/call）
#    /mcp 需 Bearer token；无 token 应 401、带 Origin 头应 403、限流后 429
curl -s -X POST http://127.0.0.1:8005/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <BOARD_MCP_AUTH_TOKEN>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
```

> 已实测通过（2026-09）：health 200；key-auth 401/200；initialize/tools/list；create → get（content 解析为对象）→ update（自动锁版本）→ search → delete 全链路，UTF-8 中文往返无损。

## 约束与红线

- ❌ 工具面不得加入 uid 参数（身份只能来自配置，防越权）
- ❌ 不直连 app-board（必须经 APISIX key-auth 路由，网关负责准入与 trace）
- ❌ 内部路由不暴露到 nginx（`/internal/*` 只在 compose 网络内可达）
- ✅ 每次上游调用生成 `X-Request-Id`，错误消息透传服务端 `detail` + `request_id`
- ✅ 新增工具须同步更新本文档与 AGENTS.md §2.11
