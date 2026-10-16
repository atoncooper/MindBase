# app-note-mcp —— 笔记 MCP Server（Go + mcp-go）

> 把笔记能力以 4 个 MCP 工具暴露给 Agent：`save_note` / `list_notes` / `get_note` /
> `update_note`（名称与参数与旧 in-process 版一致；update 不带 If-Match，对齐旧行为）。

## 传输与端口

- **streamable-http**：回环 :8009 `/mcp`（app-ts bootstrap 容器内网直连）
- 双模式鉴权：外部宿主 Bearer（`NOTEMCP__UPSTREAM__UID` 固定 uid）/ 服务模式
  （apikey = APISIX_CONSUMER_KEY + 每请求 `X-Uid`）；凭证双缺 fail-closed 拒启
- 链路：本服务 → APISIX `note_internal`（key-auth，priority 100）→ app-note `/internal/note/*`
- **uid 永不出现在 LLM 参数里**：`_uid` 由 graph 注入 → 服务模式经 `X-Uid` 头传递

## 运行

```bash
go run ./mcp/app-note-mcp
docker compose up -d app-note-mcp   # 默认 profile 启动
```

规范详见 AGENTS.md §2.15（MCP 行）。
