# app-quiz-mcp —— 测验 MCP Server（Go + mcp-go）

> 把 quiz 出题/批改落库能力以 MCP 工具暴露给 Agent（与 app-note-mcp 同一套双模式鉴权与链路约定）。

## 传输与端口

- **streamable-http**：回环 :8012 `/mcp`（app-ts 容器内网直连）
- 双模式鉴权：外部宿主 Bearer（`QUIZMCP__UPSTREAM__UID`）/ 服务模式（apikey = APISIX_CONSUMER_KEY
  + 每请求 `X-Uid`）；凭证双缺 fail-closed 拒启
- 链路：本服务 → APISIX `/internal/quiz/*`（key-auth）→ app-quiz
- 日志：结构化 slog + lumberjack 轮转（镜像预建 nonroot 属主 /app/logs）

## 运行

```bash
go run ./mcp/app-quiz-mcp
docker compose up -d app-quiz-mcp   # 默认 profile 启动
```

规范详见 AGENTS.md §2.17。
