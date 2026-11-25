# 第三方 MCP Server 接入

> app-ts 通用 MCP 客户端：Streamable HTTP 传输。
> 现有内容域 app-content-mcp 保持不变；第三方 server 通过 externalMcp 单独配置。

## 配置方式

### 单 server（.env，推荐）

~~~bash
EXTERNAL_MCP__ENABLED=true
EXTERNAL_MCP__NAME=github
EXTERNAL_MCP__URL=https://mcp.example.com/mcp
EXTERNAL_MCP__HEADERS_JSON={"Authorization":"Bearer ghp_xxx"}
EXTERNAL_MCP__INCLUDE_TOOLS=search_repositories,get_file_contents
EXTERNAL_MCP__TIMEOUT_MS=30000
~~~

- INCLUDE_TOOLS 为空 = 桥接该 server 的全部工具
- HEADERS_JSON 是静态请求头，适合 Bearer / API key
- 密钥只放 .env，不写进工具参数，也不会出现在聊天记录

### 多 server（app-ts/config/default.yaml）

~~~yaml
externalMcp:
  enabled: true
  maxContentChars: 8000
  servers:
    - name: github
      enabled: true
      url: https://mcp.example.com/mcp
      headers:
        Authorization: Bearer ghp_xxx
      timeoutMs: 30000
      includeTools: [search_repositories]
      # 服务端要求 tools/list 带正整数 X-Uid 时设置
      discoveryUid: "1"
~~~

修改后重建 app-ts：

~~~bash
docker compose up -d --no-deps --force-recreate app-ts
~~~

## 工具命名与调用

外部 server 工具统一注册为：

~~~text
mcp_<server>__<tool>
~~~

例如：

~~~text
mcp_github__search_repositories
~~~

原始工具名不会被改写；调用时仍把原名发给 MCP server，只是 LLM 侧工具名带 server 前缀，避免多个 server 重名。

- 身份：继续通过 X-Uid 请求头传递（不会进入 LLM 工具参数）
- 超时：McpClient 的 timeoutMs
- 失败：transport 失败抛给 runtime 熔断；MCP 业务 isError 作为文本返回模型
- 工具输出：按 maxContentChars 截断，避免撑爆上下文
- 启动失败：单个 server 发现失败只告警，不影响其他工具和服务启动
- 外部工具会加入主 agent 工具列表；子 agent 仍使用各自白名单
- 服务端工具发现耗时会加在启动阶段（超时受 timeoutMs 限制）

## 对话左下角入口

聊天侧栏底部新增「MCP 接入」入口（与 AI 定时任务并列）：

~~~text
对话侧栏底部
  ├─ AI 定时任务
  └─ MCP 接入
~~~

页面路径 /mcp，展示：

- 已配置的 MCP server、连接状态
- 已发现的工具（原始工具名）
- .env 配置示例
- 当前配置文档入口

MCP 连接配置存于 app-user 设置域（`/settings/mcp/servers`），页面只展示脱敏信息；`POST /mcp/servers/{id}/discover` 由 app-ts 执行 tools/list 并回写工具目录。

## 执行轨迹

聊天中的执行过程会按 Codex 风格展示为纵向流程：

~~~text
MCP · github   search_repositories   执行中
       ↓
MCP · github   get_file_contents     完成 1.2s
~~~

每一步都有：

- 阶段色块（蓝 / 琥珀 / 绿 / 紫）
- 工具名、MCP server 名
- 执行中 / 完成状态和耗时
- 展开后查看 MCP 参数与 MCP 返回
- 参数/结果复制

## 本地演示（DeepWiki）

当前本地环境使用公共只读 MCP：

~~~text
https://mcp.deepwiki.com/mcp
~~~

由于本机 Docker Desktop 的透明代理暂时不可用，容器内通过宿主机反向代理接入：

~~~text
http://host.docker.internal:18080/mcp
~~~

对应 .env：

~~~bash
EXTERNAL_MCP__ENABLED=true
EXTERNAL_MCP__NAME=deepwiki
EXTERNAL_MCP__URL=http://host.docker.internal:18080/mcp
EXTERNAL_MCP__INCLUDE_TOOLS=read_wiki_structure,read_wiki_contents,ask_wiki_question
EXTERNAL_MCP__TIMEOUT_MS=30000
~~~

这是本地演示拓扑，不是生产配置。生产环境应把 URL 改成 app-ts 容器可直接访问的 MCP 地址，不依赖开发机反向代理。

## 安全边界

- 第三方 MCP server 属于外部信任域：其工具描述会进入模型上下文，其返回内容会进入对话
- 只接入可信 server；不要给不信任的 server 传生产数据库凭证
- 静态 headers 只使用最小权限 token
- MCP 工具名带 server 前缀，避免和内置工具/其他 server 冲突
- 当前只支持 Streamable HTTP；stdio transport 尚未开放（生产容器不适合任意拉起子进程）
