# 聊天域切流 app-ts + settings 迁 Go（app-settings）——上线与联调

> 2026-10-05。聊天域全有或全无（SSE 流与会话写同一存储链），本轮**全切 /chat 的
> 聊天面**到 app-ts；settings（embedding/ASR 配置族）迁 Go **app-settings**。
> Python `app/` 冻结不改动（用户决策）；旧会话历史**不导入**（留在 Python 存储，
> 不可见不删除）。回滚 = 删 APISIX `chat_ts` / `settings_user` 路由即回落 backend。

## 一、切流后的聊天拓扑

```
frontendv2 chatApi（零改动）
  ├─ POST /chat/ask/agent/stream   ─┐
  ├─ GET/POST /chat/sessions        ├─ APISIX chat_ts (priority 60) ──► app-ts :8000
  ├─ PATCH/DELETE /chat/sessions/*  │    （/chat/ask/stream 别名同	handler）
  ├─ GET/DELETE /chat/history*     ─┘
  ├─ POST /chat/board/complete      ── chat_ts（2026-10-06 起）──► app-ts
  └─ POST /chat/search              ── vec_knowledge_ts（2026-10-06 起）──► app-ts

app-ts 内部：
  ask/stream = ChatService（加权排队按 resolveTier）→ agent → tools
  会话/消息  = Mongo mind_base_ts（chat_sessions / chat_messages，自有库）
  folder_ids → app-kg ResolveScope gRPC → scope.bvids（不可达 = 无作用域 fail-open）
```

## 二、上线前必须做（顺序执行）

1. **视频知识库回灌**（否则 vector_search 空转）：
   `cd app-ts && npm run reingest:video-kb [-- --limit=50]`
   读 Python `mind_base.asr_documents`（跨库只读）→ 切块 → 网关 embedding →
   `mind_base_ts.bilibili_videos`。按 (bvid,cid) delete-then-insert 幂等，可重跑。
2. **起服务**：`docker compose --profile ts --profile settings up -d app-ts app-settings`
   （本地开发：`cd app-ts && npm run dev`；`go run ./app-go/app-settings`）。
3. **APISIX reload**（两份 yaml 均已含 `upstream-app-ts` / `upstream-app-settings` +
   `chat_ts` / `settings_user` 路由）。

## 三、冒烟清单

- 会话：创建/列表/重命名/删除/清空历史 → 响应字段 snake_case 与 Python 版 diff。
- 流式：`POST /chat/ask/agent/stream`（带 `chat_session_id` + `folder_ids`）→
  chunk/step/sources/error/done 帧正常、会话与消息落 mind_base_ts、
  folder 作用域生效（app-kg 在线时）。
- regenerate：`DELETE /chat/history/from/{msg_id}?chat_session_id=` → `deleted` 计数。
- settings：embedding-configs CRUD → test（错误 key → `API Key 无效…`）→ default；
  asr-configs 同构；跨用户 404；`/settings/credentials/*` = 404（死面）。
- 回滚演练：删 `chat_ts` 路由 → 前端回到 Python 链路（旧会话历史重新可见）。

## 四、已知取舍

1. **旧会话历史不可见**（用户决策不导入）；Python 存储未删，需要时可写导入脚本。
2. **list_videos / get_video_summaries 默认关闭**（`toolsStub.videoMeta: false`，
   VideoMetaRepository 是内存假数据）；回灌后如需启用，先接真元数据源。
3. **/chat/search、/chat/ask（非流式）、/chat/ask/agentic**：/chat/search 已于
   2026-10-06 迁 app-ts（`vec_knowledge_ts`）；非流式 ask/agentic 为死面，随
   Python 退役直接删除（前端仅用流式）。
4. **会话摘要端点（session_summary）**：✅ 2026-10-06 已迁 app-ts
   （`SessionSummaryService` + Mongo `mind_base_ts.session_summaries`），
   本条「留 Python」作废。
5. **board_uuid 板聊直路由**未在 app-ts 实现（Python §2.12 行为）；板聊经 main agent
   委托 board agent 可用。
6. app-ts 的 `usage` 映射为 `tokens_used`；`model`/`artifacts` 字段不 emit（前端
   history 渲染不消费）。

## 五、回滚

| 变更 | 回滚方式 |
|---|---|
| 聊天域 | 删 APISIX `chat_ts` 路由（/chat/* 落回 chat_sse/catch_all → Python；旧会话历史随之恢复可见） |
| settings | 删 APISIX `settings_user` 路由（/settings/* 落回 catch_all → Python） |
| 数据 | mind_base_ts 的 chat_sessions/chat_messages 为 app-ts 自有数据，与 Python 存储无双向依赖，无需清理 |

> ⚠️ 上表回滚路径已随 2026-10-06 Python 彻底退役失效（Python 面与 catch_all 已删），
> 仅作切流当时的历史记录保留。

## 六、2026-10-06 后续更新（Python 彻底退役）

- Python `app/` 整体删除，APISIX 无 catch_all——本节拓扑图中所有「留 Python」
  项已清零：board complete、session summary、/chat/search 均在 app-ts。
- 回滚表仅剩「数据」一行仍有效；聊天域/settings 的 Python 回退已不可能。
- 退役全貌见 [python-decommission.md](python-decommission.md)。
