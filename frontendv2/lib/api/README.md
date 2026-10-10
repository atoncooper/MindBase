# lib/api/ — 后端 API 调用层

> 本目录是前端**唯一**允许发起后端调用的入口（按域分模块，统一客户端在
> `client.ts`）。组件内禁止直接 `fetch`。所有请求经 APISIX 网关
> （浏览器 → nginx → APISIX → 各服务），身份一律走 `Authorization: Bearer
> <bili_session>`，`X-Uid`/`X-Roles` 由网关注入——**任何模块都不传 uid 参数**。

## 域 → 后端服务映射（Python backend 退役后，无 catch_all 兜底）

| 模块 | 路径前缀 | 后端服务（APISIX 路由） |
|---|---|---|
| `auth.ts` / `user.ts` | `/auth/*` | app-auth（认证权威） |
| `chat.ts` | `/chat/ask/agent/stream`、`/chat/sessions*`、`/chat/history*` | app-ts（`chat_ts`） |
| `session-summary.ts` | `/chat/sessions/{id}/summary` | app-ts（`chat_ts` 覆盖） |
| `boards.ts` | `/board/*` | app-board；AI 补全 `/chat/board/complete` → app-ts |
| `favorites.ts` | `/favorites*` | app-bili（获取权威） |
| `asr.ts` | `/asr/*` | app-bili |
| `knowledge.ts` | `/knowledge/*`（**三分**） | build/status/folders-sync → app-bili；stats/folders-status/pages-vectorized/clear/video → app-ts（`vec_knowledge_ts`） |
| `kg.ts` | `/knowledge/kg/*` | app-ts（AI 编排）+ app-kg（gRPC 存储） |
| `vec-page.ts` | `/vec/page/*` | app-ts（向量账本 = Mongo `mind_base_ts.vec_pages`） |
| `blindspot.ts` | `/blindspot/*` | app-ts |
| `skills.ts` | `/skills/*` | app-ts（zip 存 MinIO，元数据在 Mongo `mind_base_ts.skills_meta`） |
| `quiz.ts` | `/quiz/*` | history/错题/导出/分享/详情 → app-quiz；generate / generate-from-summary / submit → app-ts（`quiz_ai*` priority 更高） |
| `task-quiz.ts` | `/task-quiz/*`、`/tasks*` | register/chat → app-ts；detail/answer → app-quiz；调度列表 `/tasks*` → app-task |
| `notes.ts` | `/notes/*` | app-note（笔记权威） |
| `cloud.ts` | `/cloud/*` | app-cloud（云盘权威；5GB 上传走 nginx 直连） |
| `workspace.ts` | `/workspaces*` | app-cloud（检索工作区，camelCase wire） |
| `pay.ts` | `/pay/*` | app-pay（会员/订单，金额一律 long 分） |
| `preferences.ts` | `/preferences`、`/wallpaper/*` | app-settings（app-settings 仅剩这一域，见下方退役说明） |

已删除的死面（后端无对应路由，勿复活）：`code-executions.ts`
（`/chat/messages/*` 无实现）、`settings.ts`（legacy `/settings/credentials*`）、
`chatApi.ask/search`（非流式问答与搜索无路由/无消费方）、
`knowledgeApi.getVideoPages`（废弃端点未迁移，用 `favoritesV2Api.listVideoPages`）。

**用户自带 API Key（BYOK）已整体退役（2026-10-07）**：全部 AI 流量走平台网关，
用户不配置任何密钥。已删 `credentials.ts`（`/credentials*`）、
`embedding-config.ts` / `asr-config.ts`（`/settings/*-configs*`）与设置页的
key 配置 UI；`/credentials`、`/settings/*` 网关路由同步移除（404）。设置页
现在是 AI 能力说明 + 会员引导（开通入口 → `/membership`）。

## 约定

- **wire 大小写**：后端绝大多数端点 snake_case；`task-quiz.ts` 与
  `session-summary.ts` 用 `requestCamel`/`snakeToCamel` 转成 camelCase 消费；
  `boards.ts`（app-board）与 `workspace.ts`（app-cloud）原生 camelCase 直用。
- **SSE 流**：`chatApi.askStream` / `taskQuizApi.streamChat` /
  `sessionSummaryApi.streamSummary` 直连网关（绕过 Next.js dev 代理的 SSE
  缓冲），帧协议消费在 `lib/chat-stream.ts`。
- **错误体**：统一 `{"detail": string}`；`client.ts` 负责归一化 401（清登录态
  + `auth:unauthorized` 事件）与非 JSON 网关错误页。
- 新增端点时：先在后端服务与 APISIX 双 yaml 加**显式路由**（无兜底），再在本
  目录加模块并更新上表。
