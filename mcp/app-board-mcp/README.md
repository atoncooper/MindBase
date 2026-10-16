# app-board-mcp —— 思维导图/白板 MCP Server（Go + mcp-go）

> 把 app-board 的板能力以 6 个 MCP 工具暴露给任意 MCP 宿主（ZCode / Claude 等）：
> `list_boards`（标题搜索，跨页扫描上限 1000）/ `get_board` / `create_board` /
> `update_board`（乐观锁）/ `delete_board`（软删）/ `pin_board`；
> Resources=`board://{uuid}`；Prompts=`organize_into_board`/`review_board`/`board_to_outline`。

## 传输与端口

- **streamable-http**：回环 :8005 `/mcp`（app-ts 内网直连 compose 服务端口）；支持 stdio
- 双模式鉴权：外部宿主 = Bearer token（`BOARDMCP__UPSTREAM__UID` 固定身份）；服务模式 = apikey
  （`BOARDMCP__SERVER__SERVICE_API_KEY` = APISIX_CONSUMER_KEY）+ 每请求 `X-Uid`——
  **两种模式 LLM 参数都不含 uid**（红线：uid 永不出现在 LLM 可写参数里）
- 防护：双凭证缺失 fail-closed 拒启 + Origin 白名单（DNS rebinding 防御）+ 限流（10rps/burst20）
  + 并发上限（8，503）+ body 10MB（413）；stdio 模式不需要 token
- TLS 可选（`BOARDMCP__SERVER__TLS__ENABLED`）：自动生成 dev-CA + 叶子（每日巡检重签/自愈）
- 上游：APISIX `/internal/board/*`（key-auth + proxy-rewrite 去前缀）→ app-board `/board/*`；
  APISIX 侧另有 limit-req（20rps/burst10）兜底

## 运行

```bash
go run ./mcp/app-board-mcp
docker compose up -d app-board-mcp   # 默认 profile 启动（board agent 是主栈功能）
```

完整文档见 [docs/app-board-mcp.md](../../docs/app-board-mcp.md)（AGENTS.md §2.11）。
