# MindBase API 文档（当前版本）

> 适用：2026-11 起的 Go/TS/Java 服务栈（Python backend 已于 2026-10 退役）。
> 机器可读规格：[openapi.yaml](openapi.yaml)（OpenAPI 3.1，共 313 个操作）；交互式调试：[swagger-ui.html](swagger-ui.html)。
> 请求入口与鉴权速览见 [docs/api.md](../docs/api.md)；服务边界见 [docs/architecture.md](../docs/architecture.md)。

## 1. 架构与入口

```text
浏览器 / 第三方
  |  HTTPS
  v
OpenResty edge（TLS 终止、限流、缓存、/cloud 大文件直传）
  |  /mindbase/api/v1/* 去掉前缀
  v
APISIX（forward-auth / key-auth / 路由 / 限流 / 超时）
  |--> app-ts :8000        AI 域（聊天/agent/RAG/KG/向量/skills/学术）
  |--> app-user :8006      认证 / :8010 收藏·ASR / :8015 偏好·Coding Plan
  |--> app-cloud :8007     云盘 / 工作区
  |--> app-content :8004   笔记 / 测验 / 白板
  |--> app-pay :8002       交易 / 会员（HTTPS）
  |--> app-task            定时出题（独立镜像）
  |--> app-admin :8016 + frontend-admin :3001 管理台（仅回环，不经 APISIX）
```

| 场景 | Base URL |
|------|----------|
| 生产 / Docker 同源 | `https://<host>/mindbase/api/v1`（edge 去掉前缀后转发 APISIX） |
| 本地 Next.js dev | frontendv2 rewrites 转发到 `http://127.0.0.1:9080` |
| 服务间 / 内部 | `https://apisix:9443`（仅容器网络；key-auth） |
| Swagger UI | 本地静态目录打开；Servers 选择上述入口 |

### 文件结构（按域拆分）

```text
api/
├── openapi.yaml            # 根：info/servers/tags/security/components + 每个 path 一条 `$ref`
├── components/common.yaml  # 公共 securitySchemes / schemas / responses
├── paths/
│   ├── auth.yaml           # 认证
│   ├── chat.yaml           # 聊天/Agent（含 SSE）
│   ├── tasks.yaml          # 定时出题任务
│   ├── content-ops.yaml    # 收藏/ASR/知识库构建
│   ├── vector.yaml         # 向量/KG/检索
│   ├── blindspot.yaml      # 盲区
│   ├── skills.yaml         # 技能
│   ├── academic.yaml       # 学术 Agent
│   ├── quiz.yaml           # 测验
│   ├── notes.yaml          # 笔记
│   ├── cloud.yaml          # 云盘
│   ├── workspaces.yaml     # RAG 工作区
│   ├── board.yaml          # 白板
│   ├── pay.yaml            # 支付/会员
│   ├── settings.yaml       # 偏好/头像/Coding Plan
│   ├── system.yaml         # health
│   └── internal.yaml       # 内部 M2M
├── README.md
└── swagger-ui.html         # 加载 ./openapi.yaml（需 HTTP 提供，file:// 不能解析相对 `$ref`）
```

约定：

- 每个域的 path item 只写在自己的 `api/paths/<域>.yaml`；`openapi.yaml` 的 `paths` 只是 `$ref` 索引；
- 公共 schema/response/securityScheme 只写 `api/components/common.yaml`，域文件用 `../components/common.yaml#/...` 引用；
- **新增 path**：先在对应域文件加 path item，再在 `openapi.yaml` 的 `paths` 下加一条 `$ref`；
- **新增域**：新建 `api/paths/<域>.yaml`、在 `openapi.yaml` 的 `tags` 与 `paths` 补条目，并更新本节树。

## 2. 鉴权模型

| 方式 | 适用面 | 说明 |
|------|--------|------|
| `Authorization: Bearer <token>` | 用户 API | 登录后会话 token；APISIX forward-auth 宽松校验后注入 `X-Uid`/`X-Roles`，服务校验 X-Uid |
| `apikey: <APISIX consumer key>` | 内部 M2M | 仅容器网络可达；APISIX key-auth + consumer-restriction 白名单 + 服务二次校验 X-Internal-Key/X-API-Key |
| 无 | 公开端点 | 登录/注册/验证码、分享页（`/notes/shared/*`、`/quiz/shared/*`、`/cloud/s/*`）、支付回调、`/health` |
| 服务自校验 | app-user verify / app-sandbox / app-task | forward-auth 目标端点、沙箱执行面、app-task 服务面在服务内再校验 |

APISIX forward-auth 为**宽松校验**：无凭证放行（不注入身份），凭证无效返回 401；公开分享页因此可复用同一通配路由，受保护端点由服务返回 401。

## 3. 通用约定

- **请求 ID**：响应头 `X-Request-Id`；日志/上游异常可带此值排查。
- **错误体**：统一 `{"detail": "<中文错误>"}`；HTTP 语义：400 参数错误、401 未认证、403 越权、404 不存在、409 冲突（笔记 If-Match、支付状态机）、422 业务不可处理、429 限流、503 依赖不可用。
- **SSE**：`text/event-stream`，帧类型 `route` / `chunk` / `reasoning` / `reasoning_patch` / `step` / `sources` / `reset` / `error` / `done`，`: ping` 心跳；未收到 `done` 视为异常中断。SSE 路由关闭缓冲、read timeout 300s+。
- **分页**：各端点参数不同（常见 `page`/`page_size`、`limit`/`offset`、cursor）；以服务源码与专项文档为准。
- **幂等 / 并发**：支付下单支持幂等键、回调条件更新；笔记更新用 `If-Match`（冲突 409）；上传分片有 session/heartbeat。
- **限流**：edge 按 IP（api/auth/general 区），APISIX 按路由/consumer；超限 429。
- **大文件**：云盘上传 metadata 经 edge 直连 app-cloud（auth_request 校验），分片直传 MinIO；播放走 `/hls/` 边缘令牌校验。

## 4. 端点总览

> 认证列：Bearer=用户登录态；apikey=内部 M2M；公开=免登录。

### auth — 登录/注册/凭证/设备/验证码（app-user）

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | `/auth/attest` | 创建/执行设备认证 | 公开 |
| GET | `/auth/attest/challenge` | 获取challenge | 公开 |
| GET | `/auth/captcha` | 获取验证码 | 公开 |
| GET | `/auth/devices` | 获取设备 | Bearer |
| DELETE | `/auth/email` | 删除邮件 | Bearer |
| PUT | `/auth/email` | 更新邮件 | Bearer |
| POST | `/auth/email/send-code` | 创建/执行send-code | 公开 |
| POST | `/auth/email/verify` | 创建/执行verify | Bearer |
| GET | `/auth/features` | 获取功能开关 | 公开 |
| POST | `/auth/login` | 创建/执行登录 | 公开 |
| GET | `/auth/me` | 获取当前用户 | Bearer |
| PATCH | `/auth/password` | 更新密码 | Bearer |
| POST | `/auth/password/reset` | 创建/执行reset | 公开 |
| POST | `/auth/password/reset-request` | 创建/执行reset-request | 公开 |
| POST | `/auth/password/set` | 创建/执行set | Bearer |
| DELETE | `/auth/phone` | 删除手机号 | Bearer |
| PUT | `/auth/phone` | 更新手机号 | Bearer |
| POST | `/auth/phone/login` | 创建/执行登录 | 公开 |
| POST | `/auth/phone/send-code` | 创建/执行send-code | 公开 |
| POST | `/auth/phone/verify` | 创建/执行verify | Bearer |
| GET | `/auth/profile` | 获取资料 | Bearer |
| PATCH | `/auth/profile` | 更新资料 | Bearer |
| GET | `/auth/qrcode` | 获取二维码 | 公开 |
| GET | `/auth/qrcode/poll/{qrcode_key}` | 获取poll | 公开 |
| POST | `/auth/register/email` | 创建/执行邮件 | 公开 |
| POST | `/auth/register/email/send-code` | 创建/执行send-code | 公开 |
| GET | `/auth/security` | 获取安全设置 | Bearer |
| DELETE | `/auth/token` | 删除令牌 | Bearer |
| DELETE | `/auth/tokens` | 删除令牌 | Bearer |
| GET | `/auth/tokens` | 获取令牌 | Bearer |
| DELETE | `/auth/tokens/{session_id}` | 删除令牌 | Bearer |
| POST | `/auth/wechat/bind` | 创建/执行bind | Bearer |
| POST | `/auth/wechat/login` | 创建/执行登录 | 公开 |
| GET | `/auth/wechat/qrcode` | 获取二维码 | Bearer |

### chat — SSE 对话、会话/历史/计划/画板/沙箱执行（app-ts）

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | `/chat/ask/agent/stream` | 创建/执行流式 | Bearer |
| POST | `/chat/ask/stream` | 创建/执行流式 | Bearer |
| POST | `/chat/board/complete` | 创建/执行补全 | Bearer |
| DELETE | `/chat/documents` | 删除文档 | Bearer |
| GET | `/chat/documents` | 获取文档 | Bearer |
| POST | `/chat/documents` | 创建/执行文档 | Bearer |
| DELETE | `/chat/history` | 删除历史 | Bearer |
| GET | `/chat/history` | 获取历史 | Bearer |
| DELETE | `/chat/history/from/{msg_id}` | 删除from | Bearer |
| GET | `/chat/models` | 获取模型 | Bearer |
| GET | `/chat/plans` | 获取计划 | Bearer |
| GET | `/chat/plans/{runId}` | 获取计划 | Bearer |
| POST | `/chat/plans/{runId}/cancel` | 创建/执行取消 | Bearer |
| POST | `/chat/plans/{runId}/resume` | 创建/执行恢复 | Bearer |
| GET | `/chat/sandbox/executions` | 获取执行 | Bearer |
| GET | `/chat/sandbox/executions/{id}` | 获取执行 | Bearer |
| POST | `/chat/sandbox/executions/{id}/cancel` | 创建/执行取消 | Bearer |
| POST | `/chat/search` | 创建/执行检索 | Bearer |
| GET | `/chat/sessions` | 获取会话 | Bearer |
| POST | `/chat/sessions` | 创建/执行会话 | Bearer |
| DELETE | `/chat/sessions/{session_id}` | 删除会话 | Bearer |
| GET | `/chat/sessions/{session_id}` | 获取会话 | Bearer |
| PATCH | `/chat/sessions/{session_id}` | 更新会话 | Bearer |
| GET | `/chat/sessions/{session_id}/summary` | 获取摘要 | Bearer |
| POST | `/chat/sessions/{session_id}/summary` | 创建/执行摘要 | Bearer |
| GET | `/quota/summary` | 获取摘要 | Bearer |

### tasks — 任务视图/报名/答题（app-task、app-ts）

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | `/task-quiz/chat` | 创建/执行对话 | Bearer |
| POST | `/task-quiz/register` | 创建/执行注册 | Bearer |
| GET | `/tasks` | 获取任务 | Bearer |
| GET | `/tasks/{task_id}` | 获取任务 | Bearer |
| POST | `/tasks/{task_id}/answer` | 创建/执行答题 | Bearer |
| GET | `/tasks/{task_id}/detail` | 获取详情 | Bearer |
| POST | `/tasks/register` | 创建/执行注册 | Bearer |

### content-ops — 收藏夹、ASR、构建编排（app-user bili 域）

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/asr/content` | 获取content | Bearer |
| POST | `/asr/create` | 创建/执行创建 | Bearer |
| POST | `/asr/reasr` | 创建/执行reasr | Bearer |
| GET | `/asr/status/{task_id}` | 获取状态 | Bearer |
| POST | `/asr/update` | 创建/执行update | Bearer |
| GET | `/asr/versions` | 获取版本 | Bearer |
| POST | `/favorites/organize/clean-invalid` | 创建/执行clean-invalid | Bearer |
| POST | `/favorites/organize/execute` | 创建/执行执行 | Bearer |
| POST | `/favorites/organize/preview` | 创建/执行预览 | Bearer |
| DELETE | `/favorites/v2/{folder_id}` | 删除v2 | Bearer |
| PATCH | `/favorites/v2/{folder_id}/selected` | 更新选中 | Bearer |
| GET | `/favorites/v2/list` | 获取列表 | Bearer |
| GET | `/favorites/v2/media/{media_id}/videos` | 获取视频 | Bearer |
| POST | `/favorites/v2/sync` | 创建/执行同步 | Bearer |
| GET | `/favorites/v2/video/{bvid}/pages` | 获取分P | Bearer |
| POST | `/knowledge/build` | 创建/执行构建 | Bearer |
| GET | `/knowledge/build/active` | 获取活跃任务 | Bearer |
| GET | `/knowledge/build/status/{task_id}` | 获取状态 | Bearer |
| POST | `/knowledge/folders/sync` | 创建/执行同步 | Bearer |

### vector — 向量化/KG/检索/清理（app-ts）

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| DELETE | `/knowledge/clear` | 删除清空 | Bearer |
| GET | `/knowledge/folders/status` | 获取状态 | Bearer |
| GET | `/knowledge/kg/active` | 获取活跃任务 | Bearer |
| POST | `/knowledge/kg/build` | 创建/执行构建 | Bearer |
| GET | `/knowledge/kg/stats` | 获取统计 | Bearer |
| GET | `/knowledge/kg/status/{task_id}` | 获取状态 | Bearer |
| GET | `/knowledge/kg/subgraph` | 获取subgraph | Bearer |
| GET | `/knowledge/pages/vectorized` | 获取向量化状态 | Bearer |
| GET | `/knowledge/stats` | 获取统计 | Bearer |
| DELETE | `/knowledge/video/{bvid}` | 删除视频 | Bearer |
| POST | `/vec/page/create` | 创建/执行创建 | Bearer |
| POST | `/vec/page/revector` | 创建/执行重向量化 | Bearer |
| GET | `/vec/page/status` | 获取状态 | Bearer |
| GET | `/vec/page/status/{task_id}` | 获取状态 | Bearer |

### blindspot — 盲区实体/图/练习（app-ts）

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | `/blindspot/{eid}/quiz` | 创建/执行测验 | Bearer |
| GET | `/blindspot/entity/{eid}` | 获取实体 | Bearer |
| GET | `/blindspot/map` | 获取图谱 | Bearer |

### skills — 技能商店/安装/预览（app-ts）

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| DELETE | `/skills/{skill_id}` | 删除技能 | Bearer |
| GET | `/skills/{skill_id}/preview` | 获取预览 | Bearer |
| POST | `/skills/install` | 创建/执行安装 | Bearer |
| GET | `/skills/installed` | 获取已安装 | Bearer |
| GET | `/skills/store/contents` | 获取内容 | Bearer |
| POST | `/skills/store/install` | 创建/执行安装 | Bearer |
| GET | `/skills/store/list` | 获取列表 | Bearer |

### academic — 科研项目/文献/实验/审批/导出（app-ts）

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | `/academic/approvals/{approvalId}/decision` | 创建/执行决策 | Bearer |
| GET | `/academic/documents/{documentId}` | 获取文档 | Bearer |
| GET | `/academic/documents/{documentId}/export` | 获取导出 | Bearer |
| GET | `/academic/documents/{documentId}/export/docx` | 获取docx | Bearer |
| POST | `/academic/documents/{documentId}/export/docx` | 创建/执行docx | Bearer |
| GET | `/academic/documents/{documentId}/package` | 获取package | Bearer |
| POST | `/academic/documents/{documentId}/review-response` | 创建/执行review-response | Bearer |
| POST | `/academic/documents/{documentId}/sections` | 创建/执行章节 | Bearer |
| DELETE | `/academic/documents/{documentId}/sections/{sectionKey}` | 删除章节 | Bearer |
| POST | `/academic/documents/{documentId}/submit` | 创建/执行提交批改 | Bearer |
| GET | `/academic/documents/{documentId}/versions` | 获取版本 | Bearer |
| GET | `/academic/documents/{documentId}/versions/{version}/diff` | 获取diff | Bearer |
| POST | `/academic/documents/{documentId}/versions/{version}/restore` | 创建/执行恢复 | Bearer |
| POST | `/academic/experiments/{experimentId}/cancel` | 创建/执行取消 | Bearer |
| GET | `/academic/literature/search` | 获取检索 | Bearer |
| GET | `/academic/notifications` | 获取通知 | Bearer |
| POST | `/academic/notifications/{id}/read` | 创建/执行已读 | Bearer |
| GET | `/academic/projects` | 获取项目 | Bearer |
| POST | `/academic/projects` | 创建/执行项目 | Bearer |
| DELETE | `/academic/projects/{projectId}` | 删除项目 | Bearer |
| GET | `/academic/projects/{projectId}` | 获取项目 | Bearer |
| PATCH | `/academic/projects/{projectId}` | 更新项目 | Bearer |
| POST | `/academic/projects/{projectId}/analysis/results` | 创建/执行results | Bearer |
| GET | `/academic/projects/{projectId}/approvals` | 获取审批 | Bearer |
| POST | `/academic/projects/{projectId}/approvals` | 创建/执行审批 | Bearer |
| GET | `/academic/projects/{projectId}/autopilot` | 获取自动巡航 | Bearer |
| PATCH | `/academic/projects/{projectId}/autopilot` | 更新自动巡航 | Bearer |
| POST | `/academic/projects/{projectId}/autopilot/resume` | 创建/执行恢复 | Bearer |
| POST | `/academic/projects/{projectId}/autopilot/stop` | 创建/执行停止 | Bearer |
| POST | `/academic/projects/{projectId}/autopilot/tick` | 创建/执行推进 | Bearer |
| GET | `/academic/projects/{projectId}/documents` | 获取文档 | Bearer |
| POST | `/academic/projects/{projectId}/documents` | 创建/执行文档 | Bearer |
| POST | `/academic/projects/{projectId}/documents/import` | 创建/执行import | Bearer |
| POST | `/academic/projects/{projectId}/documents/import-from-cloud` | 创建/执行import-from-cloud | Bearer |
| GET | `/academic/projects/{projectId}/events` | 获取events | Bearer |
| GET | `/academic/projects/{projectId}/events/stream` | 获取流式 | Bearer |
| GET | `/academic/projects/{projectId}/evidence` | 获取证据 | Bearer |
| GET | `/academic/projects/{projectId}/evidence/runs/{runId}` | 获取runs | Bearer |
| GET | `/academic/projects/{projectId}/experiments` | 获取实验 | Bearer |
| GET | `/academic/projects/{projectId}/export` | 获取导出 | Bearer |
| GET | `/academic/projects/{projectId}/files` | 获取文件 | Bearer |
| GET | `/academic/projects/{projectId}/gates` | 获取阶段门 | Bearer |
| POST | `/academic/projects/{projectId}/gates/sync` | 创建/执行同步 | Bearer |
| GET | `/academic/projects/{projectId}/literature` | 获取文献 | Bearer |
| POST | `/academic/projects/{projectId}/literature` | 创建/执行文献 | Bearer |
| DELETE | `/academic/projects/{projectId}/literature/{ref}` | 删除文献 | Bearer |
| PATCH | `/academic/projects/{projectId}/literature/{ref}` | 更新文献 | Bearer |
| POST | `/academic/projects/{projectId}/literature/{ref}/verify` | 创建/执行verify | Bearer |
| GET | `/academic/projects/{projectId}/literature/export` | 获取导出 | Bearer |
| GET | `/academic/projects/{projectId}/next-actions` | 获取next-actions | Bearer |
| DELETE | `/academic/projects/{projectId}/purge` | 删除purge | Bearer |
| POST | `/academic/projects/{projectId}/restore` | 创建/执行恢复 | Bearer |
| POST | `/academic/projects/{projectId}/validation` | 创建/执行validation | Bearer |
| GET | `/academic/projects/{projectId}/workspace` | 获取工作区 | Bearer |
| POST | `/academic/projects/{projectId}/workspace` | 创建/执行工作区 | Bearer |
| GET | `/academic/projects/{projectId}/workspace/files` | 获取文件 | Bearer |

### quiz — 出题/批改/历史/错题/导出/公开分享（app-content + app-ts）

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| DELETE | `/quiz/{quiz_uuid}` | 删除测验 | Bearer |
| GET | `/quiz/{quiz_uuid}` | 获取测验 | Bearer |
| PATCH | `/quiz/{quiz_uuid}` | 更新测验 | Bearer |
| GET | `/quiz/{quiz_uuid}/paper` | 获取试卷 | Bearer |
| DELETE | `/quiz/{quiz_uuid}/share` | 删除分享 | Bearer |
| GET | `/quiz/{quiz_uuid}/share` | 获取分享 | Bearer |
| POST | `/quiz/{quiz_uuid}/share` | 创建/执行分享 | Bearer |
| GET | `/quiz/export` | 获取导出 | Bearer |
| POST | `/quiz/generate` | 创建/执行生成 | Bearer |
| POST | `/quiz/generate-ai` | 创建/执行AI 生成 | Bearer |
| POST | `/quiz/generate-from-images` | 创建/执行图片出题 | Bearer |
| POST | `/quiz/generate-from-summary` | 创建/执行摘要出题 | Bearer |
| GET | `/quiz/history` | 获取历史 | Bearer |
| POST | `/quiz/resume` | 创建/执行恢复 | Bearer |
| GET | `/quiz/shared/{share_token}` | 获取公开分享 | 公开 |
| POST | `/quiz/shared/{share_token}` | 创建/执行公开分享 | 公开 |
| GET | `/quiz/styles` | 获取风格 | Bearer |
| POST | `/quiz/submit` | 创建/执行提交批改 | Bearer |
| GET | `/quiz/wrong-answers` | 获取错题 | Bearer |

### notes — 笔记 CRUD/锚点/修订/分享（app-content）

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/notes` | 获取笔记 | Bearer |
| POST | `/notes` | 创建/执行笔记 | Bearer |
| DELETE | `/notes/{note_uuid}` | 删除笔记 | Bearer |
| GET | `/notes/{note_uuid}` | 获取笔记 | Bearer |
| PATCH | `/notes/{note_uuid}` | 更新笔记 | Bearer |
| POST | `/notes/{note_uuid}/anchors` | 创建/执行锚点 | Bearer |
| DELETE | `/notes/{note_uuid}/anchors/{anchor_id}` | 删除锚点 | Bearer |
| GET | `/notes/{note_uuid}/revisions` | 获取修订 | Bearer |
| POST | `/notes/{note_uuid}/revisions/restore/{revision_id}` | 创建/执行恢复 | Bearer |
| DELETE | `/notes/{note_uuid}/share` | 删除分享 | Bearer |
| POST | `/notes/{note_uuid}/share` | 创建/执行分享 | Bearer |
| GET | `/notes/shared/{share_token}` | 获取公开分享 | 公开 |

### cloud — 文件/文件夹/上传/HLS/预览/回收站/分享（app-cloud）

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/cloud/folders` | 获取文件夹 | Bearer |
| POST | `/cloud/folders` | 创建/执行文件夹 | Bearer |
| DELETE | `/cloud/folders/{folder_id}` | 删除文件夹 | Bearer |
| PATCH | `/cloud/folders/{folder_id}` | 更新文件夹 | Bearer |
| POST | `/cloud/folders/{folder_id}/share` | 创建/执行分享 | Bearer |
| GET | `/cloud/folders/{folder_id}/shares` | 获取分享 | Bearer |
| GET | `/cloud/quota` | 获取配额 | Bearer |
| GET | `/cloud/refs` | 获取引用 | Bearer |
| POST | `/cloud/refs` | 创建/执行引用 | Bearer |
| DELETE | `/cloud/refs/{ref_id}` | 删除引用 | Bearer |
| GET | `/cloud/refs/{ref_id}/raw` | 获取原始内容 | Bearer |
| GET | `/cloud/s/{token}` | 获取s | 公开 |
| POST | `/cloud/s/{token}/access` | 创建/执行access | 公开 |
| POST | `/cloud/s/{token}/attest` | 创建/执行设备认证 | 公开 |
| GET | `/cloud/search` | 获取检索 | Bearer |
| GET | `/cloud/search/semantic` | 获取语义检索 | Bearer |
| DELETE | `/cloud/shares/{share_id}` | 删除分享 | Bearer |
| PATCH | `/cloud/shares/{share_id}/code` | 更新code | Bearer |
| DELETE | `/cloud/trash` | 删除回收站 | Bearer |
| GET | `/cloud/trash` | 获取回收站 | Bearer |
| DELETE | `/cloud/trash/{upload_uuid}` | 删除回收站 | Bearer |
| POST | `/cloud/trash/{upload_uuid}/restore` | 创建/执行恢复 | Bearer |
| POST | `/cloud/upload/{upload_uuid}/complete` | 创建/执行补全 | Bearer |
| POST | `/cloud/upload/{upload_uuid}/resume` | 创建/执行恢复 | Bearer |
| POST | `/cloud/upload/heartbeat` | 创建/执行心跳 | Bearer |
| POST | `/cloud/upload/init` | 创建/执行初始化 | Bearer |
| DELETE | `/cloud/video/{upload_uuid}` | 删除视频 | Bearer |
| GET | `/cloud/video/{upload_uuid}` | 获取视频 | Bearer |
| PATCH | `/cloud/video/{upload_uuid}` | 更新视频 | Bearer |
| GET | `/cloud/video/{upload_uuid}/hls` | 获取HLS | Bearer |
| POST | `/cloud/video/{upload_uuid}/hls/retry` | 创建/执行重试 | Bearer |
| GET | `/cloud/video/{upload_uuid}/preview` | 获取预览 | Bearer |
| POST | `/cloud/video/{upload_uuid}/process` | 创建/执行处理 | Bearer |
| GET | `/cloud/video/{upload_uuid}/raw` | 获取原始内容 | Bearer |
| POST | `/cloud/video/{upload_uuid}/reprocess` | 创建/执行重新处理 | Bearer |
| POST | `/cloud/video/{upload_uuid}/share` | 创建/执行分享 | Bearer |
| GET | `/cloud/video/{upload_uuid}/shares` | 获取分享 | Bearer |
| GET | `/cloud/video/{upload_uuid}/similar` | 获取相似 | Bearer |
| GET | `/cloud/video/{upload_uuid}/status` | 获取状态 | Bearer |
| GET | `/cloud/video/{upload_uuid}/summary` | 获取摘要 | Bearer |
| GET | `/cloud/videos` | 获取视频 | Bearer |

### workspaces — 工作区/绑定/文件（app-cloud）

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/workspaces` | 获取工作区 | Bearer |
| POST | `/workspaces` | 创建/执行工作区 | Bearer |
| DELETE | `/workspaces/{workspace_id}` | 删除工作区 | Bearer |
| GET | `/workspaces/{workspace_id}` | 获取工作区 | Bearer |
| PATCH | `/workspaces/{workspace_id}` | 更新工作区 | Bearer |
| POST | `/workspaces/{workspace_id}/bindings` | 创建/执行绑定 | Bearer |
| DELETE | `/workspaces/{workspace_id}/bindings/{binding_id}` | 删除绑定 | Bearer |
| GET | `/workspaces/{workspace_id}/files` | 获取文件 | Bearer |

### board — 板子 CRUD/置顶（app-content）

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/board/boards` | 获取白板 | Bearer |
| POST | `/board/boards` | 创建/执行白板 | Bearer |
| DELETE | `/board/boards/{uuid}` | 删除白板 | Bearer |
| GET | `/board/boards/{uuid}` | 获取白板 | Bearer |
| PUT | `/board/boards/{uuid}` | 更新白板 | Bearer |
| PATCH | `/board/boards/{uuid}/pin` | 更新pin | Bearer |

### pay — SKU/订单/会员/二维码/回调（app-pay）

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | `/pay/callback/alipay` | 创建/执行支付宝 | 公开 |
| GET | `/pay/channels` | 获取渠道 | Bearer |
| GET | `/pay/comparison` | 获取对比 | Bearer |
| GET | `/pay/membership` | 获取会员 | Bearer |
| POST | `/pay/mock/confirm` | 创建/执行确认 | Bearer |
| GET | `/pay/orders` | 获取订单 | Bearer |
| POST | `/pay/orders` | 创建/执行订单 | Bearer |
| GET | `/pay/orders/{orderNo}` | 获取订单 | Bearer |
| POST | `/pay/orders/{orderNo}/cancel` | 创建/执行取消 | Bearer |
| GET | `/pay/orders/{orderNo}/qr` | 获取二维码 | Bearer |
| GET | `/pay/products` | 获取商品 | Bearer |
| GET | `/pay/tiers` | 获取档位 | Bearer |
| GET | `/pay/upgrade-quotes` | 获取升级报价 | Bearer |

### settings — 偏好/头像/Coding Plan（app-user）

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/avatar/file/{object_key}` | 获取文件 | Bearer |
| POST | `/avatar/upload` | 创建/执行上传 | Bearer |
| GET | `/preferences` | 获取偏好 | Bearer |
| PATCH | `/preferences` | 更新偏好 | Bearer |
| GET | `/settings/coding-plans` | 获取Coding Plan | Bearer |
| POST | `/settings/coding-plans` | 创建/执行Coding Plan | Bearer |
| DELETE | `/settings/coding-plans/{id}` | 删除Coding Plan | Bearer |
| PATCH | `/settings/coding-plans/{id}` | 更新Coding Plan | Bearer |
| GET | `/settings/coding-plans/{id}/models` | 获取模型 | Bearer |
| POST | `/settings/coding-plans/{id}/test` | 创建/执行测试 | Bearer |

### system — 健康检查

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/health` | 获取健康检查 | 公开 |

### internal — 服务间 key-auth 接口，仅服务网内调用

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | `/internal/ai-usage` | 创建/执行AI 计量 | apikey |
| GET | `/internal/board/boards` | 获取白板 | apikey |
| POST | `/internal/board/boards` | 创建/执行白板 | apikey |
| DELETE | `/internal/board/boards/{uuid}` | 删除白板 | apikey |
| GET | `/internal/board/boards/{uuid}` | 获取白板 | apikey |
| PUT | `/internal/board/boards/{uuid}` | 更新白板 | apikey |
| PATCH | `/internal/board/boards/{uuid}/pin` | 更新pin | apikey |
| POST | `/internal/email/send` | 创建/执行发送 | apikey |
| GET | `/internal/note/notes` | 获取笔记 | apikey |
| POST | `/internal/note/notes` | 创建/执行笔记 | apikey |
| GET | `/internal/note/notes/{note_uuid}` | 获取笔记 | apikey |
| PATCH | `/internal/note/notes/{note_uuid}` | 更新笔记 | apikey |
| POST | `/internal/pay/grant` | 创建/执行开通 | apikey |
| GET | `/internal/pay/membership/{uid}` | 获取会员 | apikey |
| POST | `/internal/pay/orders/{orderNo}/refund` | 创建/执行退款 | apikey |
| POST | `/internal/pay/orders/{orderNo}/refund/reject` | 创建/执行驳回 | apikey |
| GET | `/internal/pay/refund-requests` | 获取退款申请 | apikey |
| POST | `/internal/pay/timeout/execute` | 创建/执行执行 | apikey |
| POST | `/internal/quiz/generate-llm` | 创建/执行generate-llm | apikey |
| POST | `/internal/quiz/grading` | 创建/执行grading | apikey |
| POST | `/internal/quiz/gradings` | 创建/执行gradings | apikey |
| GET | `/internal/quiz/quiz-signals` | 获取quiz-signals | apikey |
| POST | `/internal/quiz/quota/consume` | 创建/执行consume | apikey |
| POST | `/internal/quiz/quota/peek` | 创建/执行peek | apikey |
| POST | `/internal/quiz/sets` | 创建/执行sets | apikey |
| POST | `/internal/quiz/sets/{quiz_uuid}/fail` | 创建/执行fail | apikey |
| POST | `/internal/quiz/sets/{quiz_uuid}/progress` | 创建/执行progress | apikey |
| POST | `/internal/quiz/sets/{quiz_uuid}/questions` | 创建/执行questions | apikey |
| POST | `/internal/quiz/sets/{quiz_uuid}/questions/append` | 创建/执行append | apikey |
| POST | `/internal/quiz/sets/{quiz_uuid}/reopen` | 创建/执行reopen | apikey |
| GET | `/internal/quiz/status/{task_id}` | 获取状态 | apikey |
| POST | `/internal/quiz/submissions` | 创建/执行submissions | apikey |
| POST | `/internal/quiz/tasks` | 创建/执行任务 | apikey |
| POST | `/internal/quiz/tasks/{task_id}/generated` | 创建/执行generated | apikey |
| GET | `/internal/quiz/wrong-answers` | 获取错题 | apikey |
| GET | `/internal/settings/coding-plan/{uid}` | 获取Coding Plan | apikey |
| POST | `/internal/task/{task_id}/complete` | 创建/执行补全 | apikey |

## 5. 内部 M2M 路由

| 路径 | APISIX route | consumer 白名单 | 调用方 |
|------|--------------|-----------------|--------|
| GET | `/internal/pay/membership/{uid}` | `pay_internal_membership` | internal / pay_readonly | app-cloud / app-ts / app-sandbox |
| POST | `/internal/pay/grant` | `pay_internal_grant` | pay_ops | app-admin |
| POST | `/internal/pay/orders/{orderNo}/refund` | `pay_internal_orders` | pay_ops | app-admin |
| POST | `/internal/pay/orders/{orderNo}/refund/reject` | `pay_internal_orders` | pay_ops | app-admin |
| GET | `/internal/pay/refund-requests` | `pay_internal_refund_requests` | pay_ops | app-admin |
| POST | `/internal/pay/timeout/execute` | `pay_internal` | internal | app-task |
| POST | `/internal/quiz/generate-llm` | `internal_quiz_generate` | internal | app-task |
| GET | `/internal/quiz/status/{task_id}` | `internal_quiz_status` | internal | app-task |
| POST | `/tasks/register` | `tasks_register` | internal | app-ts |
| POST | `/internal/task/{task_id}/complete` | `internal_task_complete` | internal | app-ts |
| POST | `/internal/email/send` | `internal_email_send` | internal | app-ts |
| GET | `/internal/settings/coding-plan/{uid}` | `coding_plan_internal` | internal | app-ts |
| GET/POST | `/internal/board/*` | `board_internal` | internal | app-content-mcp |
| GET/POST/PATCH | `/internal/note/*` | `note_internal` | internal | app-content-mcp |
| POST/GET | `/internal/quiz/*` | `quiz_internal` | internal | app-content-mcp / app-ts |
| GET/POST | `/internal/sandbox/v1/*` | `sandbox_internal` | internal | app-ts / app-admin |
| POST | `/internal/ai-usage` | `直连 app-ts（无 APISIX 路由）` | Higress wasm | Higress usage-logger |

**不经 APISIX 的内部面**（服务网直连，禁止公网暴露）：`/internal/auth/verify`（forward-auth 插件直连）、`/internal/auth/user/*`、`/internal/bili/*`、`/internal/cloud/*`、`/internal/kg/cloud-doc/*`、app-sandbox `/internal/admin/*`、MCP `/mcp`（8019）、app-kg gRPC（8013）。

## 6. 明确不暴露

- app-admin 管理 API（:8016）与管理台 UI（:3001）：仅回环/SSH 隧道，不经 APISIX/主站 nginx；
- app-pay `/test/pay/*`、`/actuator/*`：测试/运维面，APISIX 不路由；
- 各服务 `/metrics`、`/debug/*`；
- APISIX Admin API/UI（宿主 `127.0.0.1:19180`，HTTPS + allow_admin）；
- app-ts `/agent/models`、`/agent/runtime`：调试面，当前公网 404；
- app-content-mcp `/mcp`：外部 MCP 宿主/app-ts 直连，不暴露公网。

## 7. 本地查看 / 校验

```bash
# 任意静态服务器打开 API 文档（仓库根目录）
npx --yes serve api -l 8080
# http://localhost:8080/swagger-ui.html

# YAML 解析与基础一致性
python -c "import io,yaml; d=yaml.safe_load(io.open('api/openapi.yaml',encoding='utf-8')); print(len(d['paths']))"
# 可选：Redocly 规范校验（需 Node）
npx --yes @redocly/cli lint api/openapi.yaml
```

Swagger UI 的 server 默认为 `/mindbase/api/v1`；本地直连 APISIX 时在 Servers 下拉改为 `http://127.0.0.1:9080` 并带 Bearer/apikey。

注意：拆分后 `openapi.yaml` 通过相对 `$ref` 引用 `paths/` 与 `components/`，必须通过 HTTP 提供 `api/` 目录（上面的 serve 命令即可）；直接双击 `file://` 打开 Swagger UI 会因浏览器安全策略无法加载引用。

## 8. 维护约定

1. 新增/修改服务路由后同步 `api/paths/<域>.yaml`（路径、方法、鉴权、SSE 标记），并在 `api/openapi.yaml` 的 paths 索引补/删一条 `$ref`；
2. 同步本文第 4/5 节表格，保持与 spec 一一对应；
3. 新增顶层前缀时同步 `openresty/locations.conf` 与 `apisix/apisix.yaml.template`；
4. 内部端点必须走 key-auth + 白名单，禁止出现在公开面；
5. PR 附 curl 冒烟结果（无凭证/普通用户/管理员/内部 key 四类至少各一条）。

## 9. 已知限制

- 本 spec 的 requestBody/response 为通用 JSON 结构；逐字段契约以各服务 DTO/路由源码为准（后续可引入代码生成）；
- 分页/筛选参数未逐一建模；
- 未包含管理台（app-admin）与 MCP 工具面；
- 暂无 OpenAPI 与代码路由的 CI 一致性校验（建议后续加）。

## 10. 与其他文档的关系

- [docs/api.md](../docs/api.md)：请求入口、鉴权、前缀、SSE 与错误约定（概览）；
- [docs/architecture.md](../docs/architecture.md)：服务边界与部署拓扑；
- [docs/openresty-edge.md](../docs/openresty-edge.md)：edge 限流/缓存/purge；
- [apisix/README.md](../apisix/README.md)：网关路由策略与运维。
