# Coding Plan（VIP/SVIP 第三方编程套餐）

> 2026-11-09 新增。用户可在账户设置中绑定第三方编程套餐（OpenCode Zen/Go、Kimi Coding、自定义 OpenAI/Anthropic 兼容端点），供站内 **code agent** 使用。仅 **VIP/SVIP** 可添加与启用；free 只看到升级提示。

## 1. 定位与边界

- Coding Plan 是**用户自带的第三方套餐凭证**，调用不经过 Higress 平台网关，因此不计平台 token 成本；仅按次计入 `coding_plan` 日额度（free=0，vip/svip 限次）。
- 这是 BYOK 退役后的**唯一例外**：例外只作用于 `code` 子 agent；main/note/quiz/board/academic 等仍全部走平台网关。
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
| model | 模型 ID |
| api_key_enc | AES-GCM 密文 |
| enabled | 是否启用 |
| created_at / updated_at | 时间 |

约束：每 uid 最多 5 条；同一时间内部接口取 enabled 的第一条（按 updated_at 倒序）。

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
  -> 404 没有可用 plan
  -> 403 非 VIP/SVIP
```

## 4. VIP 闸门

- app-user 调 app-pay `GET /internal/pay/membership/{uid}`（经 APISIX key-auth），60s 缓存；
- 仅 `vip`/`svip` 放行；free → 403「Coding Plan 仅 VIP/SVIP 可用」；
- 会员服务不可用 → fail-closed（503），不把付费能力误开给 free。

## 5. app-ts 使用

- `AppUserAuthClient.getCodingPlan(uid)` 30s 缓存；
- `code` agent 每轮开始时解析 plan：有则用第三方 model，无/失败/超额则回退平台网关，不阻断聊天；
- 协议：OpenAI 兼容（`@ai-sdk/openai-compatible`）、Anthropic Messages（`@ai-sdk/anthropic`）；
- 审计：每次使用打 `[CODING_PLAN]` 结构化日志；`coding_plan` quota 按次消耗。

## 6. 前端

账户页「Coding Plan」卡：

- free：展示「VIP/SVIP 可用」+ 升级按钮；
- VIP/SVIP：列表（掩码 key）、添加/编辑/删除/测试连接/启用开关；
- provider 预置 opencode / kimi / custom，protocol openai / anthropic；base_url/model 手填（以各家官方文档为准）。

## 7. 部署与配置

- app-user 新增 `app_pay.base_url`（默认 `http://apisix:9080`）与 `app_pay.key`（默认 `APISIX_CONSUMER_KEY`）；
- app-ts 的 `quota.limits.coding_plan`：free 0 / vip 100 / svip 300（可按运营调整）；
- 新增表由 app-user 启动时 CREATE IF NOT EXISTS；DDL guard 测试同步。
