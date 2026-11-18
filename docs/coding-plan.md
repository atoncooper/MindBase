# Coding Plan（VIP/SVIP 第三方编程套餐）

> 2026-11-09 新增。用户可在账户设置中绑定第三方编程套餐（OpenCode Zen/Go、Kimi Coding、自定义 OpenAI/Anthropic 兼容端点），在聊天模型选择器中显式选用后供站内对话 / **code agent** 使用。仅 **VIP/SVIP** 可添加与启用；free 只看到升级提示。

## 1. 定位与边界

- Coding Plan 是**用户自带的第三方套餐凭证**，调用不经过 Higress 平台网关，因此不计平台 token 成本；仅按次计入 `coding_plan` 日额度（free=0，vip/svip 限次）。
- 这是 BYOK 退役后的**唯一例外**：仅当用户在聊天模型选择器中显式选择 Coding Plan 模型时生效；默认模型 / 系统模型仍全部走平台网关，所选 Coding Plan 模型作用于该轮 main/note/code/quiz/board/academic 等所有 agent。
- 密钥 AES-GCM 加密存 auth 库；接口只返回掩码；日志只记 `plan_id/provider/model`，不记 key。

## 2. 数据模型（app-user settings 域（同一 MySQL），CREATE-only）

`coding_plans`：

| 列 | 说明 |
|---|---|
| id | 雪花/自增主键 |
| uid | 归属用户 |
| provider | `opencode` / `kimi` / `custom` |
| protocol | `openai` / `anthropic` |
| label | 用户可读名称（≤64） |
| base_url | API 根地址（http/https） |
| model | 默认模型；聊天框可覆盖为套餐返回的其他模型 |
| api_key_enc | AES-GCM 密文 |
| enabled | 是否启用 |
| created_at / updated_at | 时间 |

约束：每 uid 最多 5 条；同一时间内部接口取 enabled 的第一条（按 id 升序，即最早启用的套餐）。

## 3. 接口

用户面（需登录，VIP/SVIP only）：

```
GET    /settings/coding-plans
POST   /settings/coding-plans
PATCH  /settings/coding-plans/{id}
DELETE /settings/coding-plans/{id}
POST   /settings/coding-plans/{id}/test
```

内部 M2M（app-ts 拉取，`apikey` = APISIX_CONSUMER_KEY）：

```
GET /internal/settings/coding-plan/{uid}
  -> 200 {plan:{id,provider,protocol,label,base_url,model,api_key}}

GET /settings/coding-plans/{id}/models（VIP/SVIP；聊天对话框按需探测）
-> 200 {plan_id,provider,protocol,models:[...]}
-> 502 服务商模型列表不可用
-> 403 非 VIP / 404 不存在
  -> 404 没有可用 plan
  -> 403 非 VIP/SVIP
```

## 4. VIP 闸门

- app-user 调 app-pay `GET /internal/pay/membership/{uid}`（经 APISIX key-auth），60s 缓存；
- 仅 `vip`/`svip` 放行；free → 403「Coding Plan 仅 VIP/SVIP 可用」；
- 会员服务不可用 → fail-closed（503），不把付费能力误开给 free。

## 5. app-ts 使用

- `AppUserAuthClient.getCodingPlan(uid)` 30s 缓存；
- 配置只保存凭据（model 可选），**不在保存时探测模型**；聊天对话框打开模型选择器时按需调用 `/settings/coding-plans/{id}/models`；
- 选中的模型作用于本轮**所有 agent**（main + note/code/quiz/board/academic + DAG 自定义 agent），每轮只解析/扣一次 `coding_plan` 额度；
- 无 plan / 非 VIP / 会员服务不可用 / 额度耗尽 / 解析失败时回退平台网关，不阻断聊天；
- 协议：OpenAI 兼容（`@ai-sdk/openai-compatible`）、Anthropic Messages（`@ai-sdk/anthropic`）；
- OpenCode 路由要求：请求带 `x-opencode-session`（聊天会话 id，稳定复用）和产品 User-Agent；app-ts 在创建 OpenCode 模型时注入，app-user 的模型列表/测试探测使用稳定的 plan 级测试 session。旧 `/zen/*` 地址由 app-user 的 YAML provider 目录自动映射到 `/inference/*`（app-ts 不再硬编码厂商地址）；
- 审计：每次使用打 `[CODING_PLAN]` 结构化日志；`coding_plan` quota 按次消耗。

## 6. 前端

账户页「Coding Plan」卡：

- free：展示「VIP/SVIP 可用」+ 升级按钮；
- VIP/SVIP：列表（掩码 key）、添加/编辑/删除/测试连接/启用开关；
- provider 预置 OpenCode Zen/Go、Kimi、GLM、MiniMax、Qwen、DeepSeek、custom，protocol openai / anthropic；
- **厂商目录唯一来源**：`app-go/app-user/default.yaml → settings.coding_plan.providers`（YAML list，含 openai/anthropic/models URL、model_hint、legacy_base_urls）。`GET /settings/coding-plans` 同时返回 `providers`，前端不再硬编码任何厂商地址；
- base_url 在切换服务商/协议时自动填入目录中的官方 Coding 端点（可手改）：

| 服务商 | OpenAI 兼容 Base URL | Anthropic 兼容 Base URL |
|---|---|---|
| OpenCode Zen / Console | https://opencode.ai/inference/openai/v1 | https://opencode.ai/inference/anthropic/v1 |
| OpenCode Go | https://opencode.ai/inference/go/openai/v1 | https://opencode.ai/inference/go/anthropic/v1 |
| Kimi Coding | https://api.kimi.com/coding/v1 | https://api.kimi.com/coding/v1 |
| GLM Coding Plan | https://open.bigmodel.cn/api/coding/paas/v4 | https://open.bigmodel.cn/api/anthropic/v1 |
| MiniMax M Plan | https://api.minimax.cn/v1 | https://api.minimax.cn/anthropic/v1 |
| Qwen Coding Plan | https://coding.dashscope.aliyuncs.com/v1 | https://coding.dashscope.aliyuncs.com/apps/anthropic/v1 |
| DeepSeek | https://api.deepseek.com | https://api.deepseek.com/anthropic/v1 |

- 「默认模型」可选；留空时由聊天模型选择器按套餐模型列表选择。
- 列表每行「测试」调用 `POST /settings/coding-plans/{id}/test`：先探测 `{base_url}/models`，失败后发一次 `max_tokens=1` 的最小聊天请求，结果内联展示并返回模型数量。
- 「有没有获取 model 的接口」因厂商而异：MiniMax（OpenAI 协议）、DeepSeek 等提供 `{base}/models`；OpenCode 的模型目录在独立路径：Console `https://opencode.ai/inference/v1/models`、Go `https://opencode.ai/inference/go/v1/models`；Kimi/GLM/Qwen 的 Coding 端点通常也兼容 `{base}/models`；Anthropic 协议按 `/v1/models` 探测。没有列表接口时，聊天选择器只展示「默认模型」（若已配置），但「测试」仍可通过聊天探测确认连接。
- 创建时 `model` 可为空（后端不再强制），避免账户页添加套餐时出现 422。

聊天输入栏模型选择器：

- 统一列表分「系统模型」与「Coding Plan」两组；系统组包含「默认模型」+ `config/model.json` 目录，Coding Plan 组首次打开时按需探测套餐模型；
- 三选一互斥：默认模型（请求不带 `model`） / 系统模型（请求带 `model`） / Coding Plan 模型（请求带 `coding_plan_model`，不传 `model`）；
- 非 VIP 或无启用套餐时 Coding Plan 分组显示不可用，不影响系统模型选择。

## 7. 部署与配置

- app-user 新增 `app_pay.base_url`（默认 `http://apisix:9080`）与 `app_pay.key`（默认 `APISIX_CONSUMER_KEY`）；
- app-ts 的 `quota.limits.coding_plan`：free 0 / vip 100 / svip 300（可按运营调整）；
- 新增表由 app-user 启动时 CREATE IF NOT EXISTS；DDL guard 测试同步。
