# API 概览

> 本文说明请求怎么进来、怎么鉴权、有哪些前缀、流式与错误约定。
> 逐字段契约以各服务路由源码为准；服务与非 API 路由见 [architecture.md](architecture.md)，目录落位见 [project-structure.md](project-structure.md)。

---

## 一、请求入口

```text
浏览器
  │
  ▼
nginx :80 / :443（TLS 终止 + 静态页 + 缓存）
  │
  ├── /cloud/ ── auth_request ──► app-cloud（大文件上传，绕网关）
  ├── /minio-proxy/ ────────────► MinIO（同源预签名 URL）
  │
  ▼
APISIX :9080（forward-auth / key-auth / 路由 / 限流）
  │
  ├──► app-ts :8000         AI 域
  ├──► app-go/* :8006-8016  各域权威服务
  ├──► app-board :8004      板存储（HTTPS）
  ├──► app-pay :8002        交易 / 会员（HTTPS）
  └──► app-sandbox :8017    沙箱控制层（仅内部面）
````

| 场景 | 入口 |
|------|------|
| 本地开发 | `frontendv2` dev server :3000，`next.config.ts` rewrites 把 API 转发到 APISIX :9080 |
| Docker 全栈 | nginx :3000（或 80 / 443），页面与 API 同源 |
| 管理台 | 统一后台（分享审核 / 支付运营 / 沙箱 / 账户 / 审计）：回环 `http://127.0.0.1:3001`，UI 的 `/api` 同源代理到 app-admin-api :8016（不经主站 nginx / APISIX） |
| 沙箱管理 | app-admin → app-sandbox `/internal/admin/*`（服务间共享令牌） |

---

## 二、鉴权模型

| 载体 | 适用面 | 机制 |
|------|--------|------|
| `forward-auth` | 用户端点 | APISIX 调 app-user（auth 路由）`POST /internal/auth/verify` 宽验证会话；有效则**剥离客户端伪造的头**后注入 `X-Uid` / `X-Roles` |
| `key-auth` | 服务间 / 内部端点 | `apikey` 请求头（`APISIX_CONSUMER_KEY`）；覆盖 `/internal/*`、MCP、app-task 回调、沙箱执行面 |
| 免登录 | 公开面 | 分享访问页（`/cloud/s/*`、`/notes/shared/*`、quiz 分享）、`/pay/callback/*` 渠道验签 |
| Session Cookie | 管理台 | app-admin 统一账户体系（`admin_user` / `admin_session`，角色 admin/viewer），登录限流 + 首登强制改密；支付运营与账户管理共用同一会话 |
| 服务自校验 | app-sandbox | 除 APISIX key-auth 外，服务内再验 `X-API-Key`，直连无法绕过 |

**约定**：下游服务信任网关注入的 `X-Uid` / `X-Roles`，**不自验会话**；身份类参数永远不出现在 LLM 可写参数里（MCP 工具面亦不暴露 uid）。

---

## 三、前缀一览

| 前缀 | 上游 | 说明 |
|------|------|------|
| `/auth/*` | app-user（8006 auth 路由） | 扫码登录（B 站 / 微信）、密码 / 邮箱 / 手机登录、token 管理、验证码 |
| `/favorites/v2/*` | app-user（8010 bili 路由） | 收藏夹列表 / 同步 / 视频 / 分 P 元数据 |
| `/knowledge/*` | app-user（bili 路由）+ app-ts | 构建 / 状态 / 清空（获取域）；`/knowledge/kg*` 走 app-ts |
| `/asr/*`、`/vec/*` | app-user（bili 路由）/ app-ts | ASR 任务；向量化与状态 |
| `/chat/*` | app-ts | 流式问答（SSE）、会话 / 历史 / 总结 / 画板补全 |
| `/blindspot/*` | app-ts | 盲区图 / 实体详情 / 盲区出题 |
| `/notes/*` | app-note | 笔记 CRUD / 锚点 / 修订 / 分享 / 云盘转笔记 |
| `/board/*` | app-board | 板 CRUD（`If-Match` 乐观锁）/ 置顶 |
| `/quiz/*`、`/tasks/*` | app-quiz + app-ts | 题目存储 / 判题 / 错题 / 分享；生成与批改走 app-ts |
| `/task-quiz/*` | app-ts + app-task | 对话定义任务；调度与答题入口 |
| `/cloud/*`、`/workspaces/*` | app-cloud | 分片上传 / 文件夹 / 配额 / 回收站 / 分享 / 处理状态 / AI 摘要 / 语义检索 / 相似文件（nginx 直连） |
| `/skills/*` | app-ts | 技能安装 / 卸载 / 商店 |
| `/pay/*` | app-pay | SKU / 订单 / 会员（HTTPS） |
| `/preferences/*`、`/avatar/*` | app-user（8015 settings 路由） | 偏好 KV 与头像 |
| `/academic/*` | app-ts | 科研项目 / 文献 / 文档章节 / BibTeX 与 Markdown/LaTeX 导出 / 项目事件 |
| `/internal/*` | 各服务 | 服务间端点（key-auth）；不暴露到 nginx |
| `/internal/sandbox/*` | app-sandbox | 沙箱执行面（app-ts 调）；管理面仅 app-admin 可调 |
| `/api/*` | app-admin-api | 管理台 API（分享审核 / 用户只读 / 审计 / 沙箱代理 / 支付运营 `/api/pay/*` / 账户管理 `/api/console/users`），仅回环 |

---

## 四、SSE 流式协议

聊天与执行事件统一走 SSE（`text/event-stream`，客户端由 `frontendv2/lib/chat-stream.ts` 解析）：

| 帧 | 语义 |
|----|------|
| `route` | 路由决策（协议保留；前端不再展示路由到的 agent，仅用于清除排队态） |
| `reasoning` / `reasoning_patch` | 思考过程增量（不计入正文） |
| `chunk` | 正文增量 |
| `step` | 工具 / 检索步骤生命周期 |
| `sources` | 引用来源 |
| `plan` | 计划清单 |
| `artifact` | 结构化产物（卡片） |
| `interact` | 结构化交互请求（表单 / 确认） |
| `usage` | 本轮 token 用量（含委派子 agent） |
| `done` | 正常结束 |
| `error` | 错误；前端展示后恢复输入 |
| `: ping` | 心跳保活 |

**约定**：连接结束但未收到 `done` 视为异常中断，前端必须显式报错；正文为空时按错误兜底。

---

## 五、错误约定

- 统一错误体 `{"detail": "<中文说明>"}`；管理台与前端直接展示 `detail`。
- 常见状态码：`400` 参数非法（附可选值）、`401` 未登录 / 会话失效、`403` 无权限、`404` 不存在或无权限（不泄露存在性）、`409` 乐观锁冲突、`429` 限流 / 配额超限、`503` 依赖不可用（含沙箱不可达）。
- 降级语义必须诚实：依赖不可用时返回明确错误，不返回伪造的成功结果。

---

## 六、契约与 OpenAPI

- 仓库**没有**统一在线 Swagger：app-ts 是 Fastify + tsx 直跑，未暴露 OpenAPI 文档端点。
- `api/openapi.yaml` 是 Python 时代的历史规格（已退役），仅作存档，不代表当前服务；请勿据此联调。
- 当前契约以「各服务路由源码 + 本文 + 各服务 README / 专项文档」为准。
- 变更流程：改路由 → 同步 APISIX（`apisix.yaml` 与 `apisix.dev.yaml`）→（如需）nginx 分发 → 同步前端 `lib/api/` 模块与类型 → 同步文档。

---

## 相关文档

- [architecture.md](architecture.md) —— 服务清单 / 端口 / 路由 / 数据归属
- [service-key-auth.md](service-key-auth.md) —— 服务间 key-auth 体系
- [sharing.md](sharing.md) —— 公开分享的链接与访问控制
- [academic-agent.md](academic-agent.md) —— `/academic/*` 端点明细
- [app-admin.md](app-admin.md) —— 管理台 API 与鉴权
