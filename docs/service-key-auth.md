# 服务 API Key 体系：app-auth 签发 + APISIX 校验（防串用）

> 状态：设计稿（未实施）。目标：把内部服务间调用从"一把共享 key"升级为
> "按服务签发、按路由授权、可审计、可吊销"的密钥体系。

## 1. 目标与非目标

**目标**
1. 每个内部服务有独立身份的 API Key（区分"是谁在调"）。
2. 路由级授权强制（区分"它被允许调什么"），拿 A 服务的 key 调 B 服务的路由 → 网关直接 403。
3. 签发/吊销/轮换/审计收敛到 app-auth（认证权威）。
4. 零代码改动迁移各调用方（只换 env 里的 key 值）。

**非目标**
- 不改用户侧鉴权（bili_session → forward-auth 链路不动）。
- 不引入 per-key 业务限流（APISIX 现有限流保持按 remote_addr）。
- 不做密钥自动轮换（提供人工轮换流程与台账，自动化后续再说）。

## 2. 现状与问题

APISIX `consumers` 只有 1 个共享身份 `internal`，9 条 key-auth 路由共用
`APISIX_CONSUMER_KEY`：

| APISIX 路由 id | 上游 | 实际调用方 |
|---|---|---|
| internal_quiz_generate / internal_quiz_status | backend | app-task |
| scripts_upload | app-task | backend |
| tasks_register | app-task | backend |
| internal_task_complete | app-task | app-task（自报完成） |
| internal_email_send | app-task | app-task |
| pay_internal | app-pay | backend、app-cloud |
| board_internal | app-board | app-board-mcp |
| note_internal | app-note | app-note-mcp |
| /internal/ai-usage | ~~backend~~ ⚠️ 2026-10-06 backend 退役后无承接者（app-ts 未实现，usage-logger fire-and-forget 上报失败不影响主链路；插件配置在 Higress 控制台） | higress usage-logger |

问题：任何持 key 者可调任何 /internal/* 路由（无路由级授权）；日志无法归因
调用方；吊销/轮换影响面是全体；key 明文长期散布在多个服务的 env 里无台账。

## 3. 总体架构

```
┌─────────────── 控制面（app-auth，签发与台账）────────────────┐
│ 运维（admin 用户登录态）→ /auth/admin/service-keys           │
│   生成：32B 随机 → mbk_<service>_<43urlsafe>                 │
│   存储：sha256(key) 唯一索引 + 服务名/scope/过期/状态元数据    │
│   明文只在签发响应出现一次                                    │
└──────────────┬───────────────────────────────────────────────┘
               │ 运维把明文 key 分发到对应服务的 .env（一次性）
┌──────────────▼──────────── 数据面（APISIX，校验与授权）────────┐
│ consumers：backend / app-task / app-cloud /                   │
│            app-board-mcp / app-note-mcp / higress-usage       │
│ 每条 /internal/* 路由：                                        │
│   key-auth（验 key 归属哪个 consumer = 服务身份）               │
│ + consumer-restriction whitelist（该路由允许的 consumer 名单）  │
│     → 防串用的强制点                                           │
└────────────────────────────────────────────────────────────────┘
```

职责边界：**app-auth 负责"生成与台账"（它是谁、scope 声明、吊销状态）；
APISIX 负责"校验与授权"（key-auth 认别 + consumer-restriction 强制）**。
APISIX standalone 不支持 env 插值，key 值经部署脚本渲染进 apisix.yaml
（见 §9），这也意味着 APISIX 始终持有全部 key 明文——与现状一致，不新增暴露面。

## 4. Key 规范

| 项 | 约定 |
|---|---|
| 格式 | `mbk_<service>_<token>`；`<service>` 为小写 slug（`backend`、`app-note-mcp` → `app_note_mcp`）；`<token>` = 32 字节随机数 base64url（43 字符，同 bili_session 熵级） |
| 总长 | ≤ 80 字符；全串仅 `[A-Za-z0-9_-]` |
| 存储 | **sha256 hex(key)** 唯一索引。不用 bcrypt：校验路径需要按 hash 等值查询（索引点查），256-bit 熵下 sha256 无暴力破解空间；bcrypt 慢哈希用于低熵人类密码，此处反而是浪费 |
| 可辨识 | 额外存 `key_last4`（明文尾 4 字符）供控制台比对，形如 `…9f3a` |
| 前缀语义 | 前缀仅是**人工排障标签**，不是校验依据——校验只认 hash。防伪造靠熵，防串用靠 §6 的路由白名单 |

## 5. 数据模型（app-auth 所有，同库 bilirag）

```sql
create table if not exists service_api_keys (
    id             int auto_increment primary key,
    key_id         varchar(16)  not null,              -- 公开短 id（控制台引用/吊销用）
    service_name   varchar(64)  not null,              -- 归属服务（backend / app-note-mcp / ...）
    key_hash       varchar(64)  not null,              -- sha256 hex(key)
    key_last4      varchar(4)   not null,
    scopes         json         not null,              -- ["note_internal", ...]，"*" = 全部内部路由
    status         varchar(16)  not null default 'active',  -- active | revoked
    expires_at     datetime     null,                  -- null = 长期
    created_by_uid bigint       not null,              -- 签发的运维用户
    created_at     datetime     not null,
    revoked_at     datetime     null,
    revoked_reason varchar(200) null,
    constraint uq_service_api_keys_key_id   unique (key_id),
    constraint uq_service_api_keys_key_hash unique (key_hash),
    index ix_service_api_keys_service (service_name)
);
```

要点：
- **不加 `unique(service_name)`**：轮换窗口期同一服务允许新旧两把 key 同时 active。
- DDL 走 app-auth 的 `Migrate`（CREATE-if-not-exists），`service_api_keys` 加入
  `ownedTables` + 守护测试；绝不 ALTER。
- Mongo 不涉及；Redis 不涉及。

## 6. Scope 模型（防串用的授权语义）

**scope 值 = APISIX 路由 id**，不另造一套语法。app-auth 内置静态注册表：

```go
// internal/service/service_key_service.go
var KnownScopes = map[string]string{ // scope → 人工可读说明（控制台展示）
    "internal_quiz_generate":  "app-task → 主 app 出题",
    "internal_quiz_status":    "app-task → 主 app 查状态",
    "scripts_upload":          "backend → app-task 脚本上传",
    "tasks_register":          "backend → app-task 注册任务",
    "internal_task_complete":  "app-task → 任务完成回执",
    "internal_email_send":     "app-task → 邮件投递",
    "pay_internal":            "会员态查询/补偿开通",
    "board_internal":          "板子 MCP 上游",
    "note_internal":           "笔记 M2M",
}
```

**授权判定不在数据面做**——scope 表的运行时消费者是：
1. **签发时的约束**（运维只能从 KnownScopes 勾选，控制台/接口双重校验）；
2. **APISIX 白名单的渲染源**（§9 脚本从 app-auth 导出 scope→consumer 映射，渲染
   apisix.yaml 的 consumer-restriction 段，杜绝手抄错位）；
3. **APISIX 访问日志的归因注释**。

即：授权的**强制点在 APISIX**（`consumer-restriction`），app-auth 的 scope 是
"声明台账 + 渲染源"，两者经脚本保持一致，漂移在渲染时暴露。

## 7. app-auth 端点设计

新增 `internal/router/admin_keys.go` + `internal/service/service_key_service.go`
+ `internal/repo/service_key_repo.go` + `internal/model`。全部挂现有
`authGuard`（session token → uid）+ **admin 角色校验**（X-Roles 含 `admin`，
app-auth 自有 rbac，无外部依赖）。

### 管理面（控制台/运维用）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/admin/service-keys` | 签发。入参 `{service_name, scopes[], expires_in_days?}`；出参 `{key_id, key(明文，仅此一次), scopes, expires_at}`。服务名必须匹配 `^[a-z0-9_-]{2,32}$`；scopes ⊆ KnownScopes |
| GET | `/auth/admin/service-keys` | 台账列表（key 脱敏为 `mbk_xxx_****last4`，含状态/过期/签发人） |
| POST | `/auth/admin/service-keys/{key_id}/rotate` | 轮换：签发新 key（同 service/scopes）+ 旧 key 置 30 天后过期，返回新明文 |
| DELETE | `/auth/admin/service-keys/{key_id}` | 吊销（body 必填 `reason`，落 revoked_reason） |

审计：签发/轮换/吊销写 app-auth 既有审计日志（`[AUTH]` slog 结构化，记操作者
uid/key_id/service/reason，不记明文）。

### 数据面（服务自检用，可选但建议）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/internal/auth/service-keys/self-verify` | 调用方带自己的 `apikey` 头，app-auth 按 hash 查库：active 且未过期 → `200 {service_name, scopes}`；吊销/过期/未知 → 401。**不经过 APISIX forward-auth，是各服务启动自检/周期复验端点** |

这个端点补上 standalone APISIX 的短板——**静态 key 无法热吊销**：
APISIX 侧吊销后必须 reload 才拒绝；配合服务侧"启动自检 + 每 5 分钟复验，
复验 401 即拒绝出站调用"，吊销的实际生效时间 ≤ 5 分钟，且不需要
每台服务重新部署。v1 只要求 app-note-mcp / app-note 接入自检，其余服务跟进。

### 管理面的引导（bootstrap）

无需额外引导 key：管理端点挂 admin **用户**会话（authGuard + rbac admin），
运维用管理员账号登录后 curl/控制台操作即可。app-auth 已有 admin 角色与
SeedDefaults，闭环完整。

## 8. APISIX 改造

### consumers：一服务一条

```yaml
consumers:
  - username: backend
    plugins: { key-auth: { key: "<APISIX_KEY_BACKEND>" } }
  - username: app-task
    plugins: { key-auth: { key: "<APISIX_KEY_APP_TASK>" } }
  - username: app-cloud
    plugins: { key-auth: { key: "<APISIX_KEY_APP_CLOUD>" } }
  - username: app-board-mcp
    plugins: { key-auth: { key: "<APISIX_KEY_BOARD_MCP>" } }
  - username: app-note-mcp
    plugins: { key-auth: { key: "<APISIX_KEY_NOTE_MCP>" } }
  - username: higress-usage            # usage-logger Wasm 插件上报 /internal/ai-usage
    plugins: { key-auth: { key: "<APISIX_KEY_HIGRESS>" } }
```

### 路由：key-auth 之上加 consumer-restriction

```yaml
  - id: note_internal
    uri: /internal/note/*
    priority: 100
    upstream_id: upstream-app-note
    plugins:
      request-id: {}
      key-auth: {}
      consumer-restriction:
        type: consumer_name
        whitelist: [app-note-mcp]          # 只有笔记 MCP 的 key 能进
      limit-req: { ... }                   # 原样保留
```

白名单矩阵（渲染脚本的输入即 §6 注册表 + 本表）：

| 路由 id | whitelist |
|---|---|
| internal_quiz_generate / internal_quiz_status | [app-task] |
| scripts_upload / tasks_register | [backend] |
| internal_task_complete / internal_email_send | [app-task] |
| pay_internal | [backend, app-cloud] |
| board_internal | [app-board-mcp] |
| note_internal | [app-note-mcp] |
| /internal/ai-usage | [higress-usage] |

**效果**：拿 app-note-mcp 的 key 调 pay_internal → key-auth 通过（key 合法）
但 consumer-restriction 403（`The consumer is forbidden`）——串用被网关强制
拦截，且 APISIX 错误日志里直接可见 consumer 名与路由 id，归因零成本。

旧共享 consumer `internal` 在全部路由切换并验证后删除。

## 9. 渲染与部署（解决 standalone 不支持 env 插值）

1. `scripts/render-apisix-keys.sh`（新增）：
   - 调 app-auth 管理端点按 §8 矩阵逐服务签发（或读取 `.env` 已有值幂等跳过）；
   - 以 `apisix/apisix.yaml.template`（新增，含 `__KEY_<SERVICE>__` 占位符）渲染出
     `apisix/apisix.yaml`（gitignore 产物，模板进 git）；
   - 同时把每个服务的 key 写回 `.env` 对应变量（已存在的跳过并提示指纹比对）。
2. `.env.example` 新增段：`APISIX_KEY_BACKEND=` 等 6 个变量 + 注释
   （⚠️ 由 app-auth 签发，勿手工造值；`APISIX_CONSUMER_KEY` 标记 deprecated 保留一个周期）。
3. 各服务 compose env 替换：
   - backend：`APISIX_CONSUMER_KEY` → `APISIX_KEY_BACKEND`（消费点：board-mcp
     service key、note-mcp service key、app-pay membership、app-task consumer）；
   - app-note-mcp：`NOTEMCP__UPSTREAM__API_KEY` / `NOTEMCP__SERVER__SERVICE_API_KEY`
     ← `APISIX_KEY_APP_NOTE_MCP`；
   - app-board-mcp 同理；app-task / app-cloud 各自替换。
4. 上线顺序：签发 → 渲染 APISIX 并 reload（此时新旧 key 并存：旧 consumer
   `internal` 保留）→ 逐服务滚动替换 env 并重启 → 全部完成后删 `internal`
   consumer 再 reload。回滚 = 恢复旧 apisix.yaml + 旧 env（key 未变过，无缝）。

## 10. 服务身份与用户身份的双轨说明

内部调用同时携带两个正交身份，明确区分：

| 身份 | 载体 | 签发/校验方 | 含义 |
|---|---|---|---|
| **服务身份** | `apikey` 头（key-auth → consumer） | app-auth 签发、APISIX 校验 | "哪个服务在调"（授权、审计、限流的主体） |
| **用户身份** | `X-Uid` 头 | forward-auth（bili_session）→ 调用方注入 | "代表哪个用户操作"（数据属主作用域） |

约定不变：uid 永不出现在 LLM 可写参数；服务 key 永不出现在用户可见面。
`consumer-restriction` 只管服务身份；数据级隔离（跨用户 404 等）仍由各
服务自己强制，两层互不替代。

## 11. 运维手册

- **签发**：管理员登录 → `POST /auth/admin/service-keys` → 明文一次性复制进
  目标服务 `.env` → 渲染 APISIX → reload。
- **轮换**：`rotate` 端点（新旧并存 30 天）→ 分发新 key → 各处替换 → 到期自动
  expired → 台账清理。
- **吊销**：`DELETE`（reason 必填）→ APISIX reload 前旧 key 仍过网关，但目标
  服务自检端点 5 分钟内拒绝（接入了自检的服务）；完成后 reload 即全网关生效。
- **泄露应急**：立即 DELETE → reload → 按台账核对泄露 key 的 scope 圈定影响
  面（这就是 scope 最小化的价值：泄露 note-mcp 的 key 拿不到 pay 数据）。
- **审计查询**：app-auth slog 审计（生命周期事件）+ APISIX 访问日志（使用行为，
  含 consumer 名）。

## 12. 失败模式

| 故障 | 影响 | 处置 |
|---|---|---|
| app-auth 宕机 | **数据面不受影响**（APISIX 静态校验不依赖它）；仅无法签发/吊销/自检 | 无需紧急处置，恢复即可 |
| APISIX 配置漂移（手改 yaml 漏了白名单） | 该路由退化为"任意合法 key 可调" | 渲染脚本幂等重跑即可收敛；模板进 git 防手改 |
| key 明文进日志 | 泄露面扩大 | 管理端点响应不落日志（app-auth 日志脱敏已覆盖）；APISIX 侧 key-auth 不打 key |
| 调用方 env 配错（装了别人的 key） | 启动即 403（consumer-restriction），错误信息含 consumer 名 | 按报错换正确 key |

## 13. 安全清单（实施自查）

- [ ] key 明文只在签发响应与目标服务 .env 出现；app-auth 库里只有 sha256
- [ ] 管理端点全部 admin 角色 + 会话鉴权；吊销 reason 必填
- [ ] consumer-restriction 白名单覆盖全部 9 条 key-auth 路由，无遗漏（脚本断言）
- [ ] 旧共享 consumer `internal` 删除后，全仓库 grep `APISIX_CONSUMER_KEY` 仅剩
      deprecated 标记
- [ ] guard 测试：`service_api_keys` 进 ownedTables，禁 ALTER
- [ ] self-verify 端点按 hash 点查 + 状态/过期判断，未知 key 统一 401（不泄漏存在性）
- [ ] 日志不出现 key 明文/完整 hash（tail4 即可）

## 14. 实施拆分

| PR | 内容 | 验证 |
|---|---|---|
| PR1（app-auth） | model/repo/service/router 四件套 + KnownScopes 注册表 + guard/单测（签发格式、hash 唯一、轮换并存、吊销状态机、scope 校验、self-verify） | `go test ./...` + 本地 curl 走通签发→台账→吊销 |
| PR2（APISIX + 分发） | apisix.yaml.template + render 脚本 + consumers 拆分 + consumer-restriction 矩阵 + .env.example + 各 compose env | 干跑渲染 diff；起栈后逐路由验证白名单 403/200 |
| PR3（可选，后续） | app-note-mcp / app-note 启动自检 + 5 分钟复验；其余服务跟进；expiring 提醒 | 手动吊销后观察 5 分钟内拒绝 |

## 15. 验收清单

- [ ] 每个服务持有独立 key；APISIX 日志可归因 consumer
- [ ] 交叉调用（note-mcp key → pay_internal）得到 403，报错含 consumer 名
- [ ] 吊销某 key 后：self-verify 401；reload 后网关 401
- [ ] 轮换期间新旧 key 并存可用
- [ ] 用户侧全部功能（聊天/笔记/云盘/支付）回归通过，鉴权链路无感知
