# AI 用量额度

> 用户侧统一显示为 **Credits**；本文实现口径中的「标准 token」是内部归一单位，
> 1 个内部单位在界面上显示为 1 Credit，模型单价仍决定实际扣减速度。
（token 口径）

> 状态：2026-11-22 落地。权威实现：`app-ts/src/services/quota.ts` +
> `app-ts/src/repository/{memory,redis}/quota-counter.ts`；配置：`app-ts/config/default.yaml` 的 `quota:` 段。
> 前端：`frontendv2/components/quota/quota-view.tsx` + `frontendv2/lib/api/quota.ts`。

## 1. 为什么改成 token

旧口径是「每种能力每天多少次」：聊天 30/100/300 条、出题 3/20/60 批……。它有三个问题：

1. **同一次调用成本差异巨大**：一条 200 字问答和一次长文出题都算「1 次」；
2. **模型差异无法体现**：GLM Flash 与旗舰推理模型的成本可能差 10 倍以上；
3. **用户无法自由分配**：Kimi、豆包等产品已经把「各功能独立计次」改为**统一额度池**，按真实 token 消耗扣减。

因此本系统改为：

- **单位 = 标准 token**（normalized token），不是条数、不是次数；
- **三层窗口**：滚动 5 小时 + 自然日 + 自然月；
- **一个池子**：聊天、出题、批改、KG、向量化、OCR、Board、科研共用；
- **模型权重**：贵模型每个真实 token 扣更多标准 token；
- **订阅放大**：¥48 VIP = ¥480 等值（默认 10×）；SVIP ¥148、ProMax ¥248 同倍率。

## 2. 产品参照（2026-11）

| 产品 | 窗口 | 计量 | 共享 | 说明 |
|---|---|---|---|---|
| **Codex / ChatGPT** | 5 小时 + 每周 | token | ChatGPT 与 Codex 共享（2026-12 起） | 官方描述「用量按 token 计，模型越强/任务越复杂消耗越多」 |
| **Claude Code** | 5 小时会话 + 每周 | 用量 | Claude 与 Claude Code 共享 | Pro/Max 档位按倍数给额度 |
| **Kimi** | 月度额度池 + Kimi Code 滚动 5 小时 | 实际 token | Agent/PPT/文档/Code 等共享 | 月度刷新、不结转；新套餐 Code 无周限额 |
| **豆包专业版** | 月度订阅 | 额度 | 三档套餐 | 68/200/500 元档；相对免费版 5×/20×/50×（加强 = 标准 4×，高级 = 标准 10×） |
| **MindBase（本实现）** | **5 小时 + 日 + 月** | **标准 token** | **全部 AI 能力共享** | 模型单价归一 + 10× 订阅权益 |

参考：
- Codex pricing: <https://developers.openai.com/codex/pricing>
- Claude usage limits: <https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work>
- Kimi 额度规则: <https://www.kimi.com/help/membership/membership-update-rules>
- Kimi 计费升级: <https://www.kimi.com/membership-credits>
- 豆包专业版报道: <https://app.dahecube.com/nweb/wap/article.html?artid=278187>
- Codex app-server 窗口字段（社区整理，5h/7d/monthly 三种窗口独立返回）: <https://github.com/shanggqm/codexU/blob/main/RESEARCH.md>
- Langfuse Codex 用量/成本追踪（GitHub docs）: <https://github.com/langfuse/langfuse-docs/blob/main/content/resources/engineering/codex-usage-cost-tracking.mdx>

> 产品规则会变；本仓库只对齐「按 token / 多窗口 / 共享池 / 模型倍率」这四个结构性设计，不复制具体额度数字。

## 3. 额度单位与换算

### 3.1 标准 token

配置项 `quota.referencePricePerMTok`（默认 **10 元/百万 token**）定义「1 个标准 token 值多少钱」：

```
1 标准 token = referencePricePerMTok / 1_000_000 元
             = ¥0.00001（默认）
```

模型的额度权重 = 模型单价 / 参考价：

```
inputWeight  = price.input  / referencePricePerMTok
outputWeight = price.output / referencePricePerMTok
```

一次成功调用的扣减：

```
quotaTokens = ceil(inputTokens × inputWeight + outputTokens × outputWeight)
```

- 便宜模型权重 < 1：同样多的钱能跑更多真实 token；
- 贵模型权重 > 1：同样真实 token 扣更多额度；
- 未配置价格的模型回退默认模型价；`quota.modelWeights` 可显式覆盖（促销/协议价）。

### 3.2 订阅价值：48 → 480

`quota.planBonus`（默认 **10**）把订阅价格放大为「等值用量」：

```
monthlyTokens = priceYuan × planBonus / referencePricePerMTok × 1_000_000
valueYuan     = monthlyTokens × referencePricePerMTok / 1_000_000
```

默认值：

| 档位 | 价格 | 5 小时 | 每日 | 每月 | 等值 | 倍率 |
|---|---:|---:|---:|---:|---:|---:|
| free | ¥0 | 6,000 | 30,000 | 300,000 | ¥3 | — |
| vip | ¥48 | 320,000 | 1,600,000 | 48,000,000 | **¥480** | **10×** |
| svip | ¥148 | 986,667 | 4,933,333 | 148,000,000 | ¥1,480 | 10× |
| promax | ¥248 | 1,653,333 | 8,266,667 | 248,000,000 | ¥2,480 | 10× |

- **¥48 VIP = ¥480 等值 = 4800 万标准 token**（按 ¥10/百万参考价）。
- 年卡累计：VIP 5.76 亿、SVIP 17.76 亿、ProMax 29.76 亿标准 token/年（约 46.6 / 143.6 / 240.6 亿原始 token，默认模型 5:1）。
- 这里的「480」是**人民币等值用量**，不是 480 万 token。若运营口径要「48 元 = 480 万 token」，把 `plans.vip.monthlyTokens` 改为 4,800,000（或删掉该字段让 `planBonus` 推导），并同步下调日/5h 预算。
- 免费档是赠送额度（¥3 等值），不参与购买倍率。
- 套餐按「档位」给月度额度；季付/年付的价格折扣天然让实际倍率高于 10×，属于「最优惠」的一部分。

> 会员页的档位权益文案**不在前端**：唯一维护点是 app-pay 的
> `TierCatalogService`（benefits/comparison）+ `src/main/resources/tiers/*.md`。
> 改完必须重建/重启 `app-pay`，否则前端即使已是新 bundle，会员页仍展示旧文案。

### 3.3 直观例子

一次 2,000 input + 500 output 的对话：

| 模型 | 真实 token | 权重（入/出） | 扣减标准 token | VIP 每日可跑 | VIP 每月可跑 |
|---|---|---:|---:|---:|---:|
| GLM-5.3 Flash | 2,500 | 0.0188 / 0.648 | ~362 | ~4,400 轮 | ~132,600 轮 |
| GPT-6.1 Terra Pro | 2,500 | 0.5 / 6 | 4,000 | ~400 轮 | ~12,000 轮 |
| Kimi K3.1 Pro | 2,500 | 0.15 / 2 | 1,300 | ~1,230 轮 | ~36,900 轮 |

> 价格是示意值，运营必须按网关实际结算价校准（见 §8）。上表说明的是**机制**：模型越贵，额度消耗越快。

### 3.4 「最优惠」的四个来源

1. **按真实单价归一**：不做「所有模型都算 1 次」的统一定价，便宜模型不会替贵模型买单；用户选便宜模型时，同样的钱能跑更多真实 token。
2. **订阅 10× 权益**：¥48 → ¥480 等值；SVIP/ProMax 同倍率，季付/年付在 SKU 层的折扣再叠加，实际倍率更高。
3. **失败/重试不扣**：consume-on-success；图片附件只做准入检查，实际扣减按本轮 provider usage，避免「估一次 + 真实一次」的重复收费。
4. **可运营的促销位**：`quota.modelWeights` 可对指定模型做折扣（只影响额度，不影响成本账本），促销结束改回即可，不需要发版。

## 4. 三层窗口

| 窗口 | 键 | 重置 | 说明 |
|---|---|---|---|
| 5 小时滚动 | `...:5h:{epochBucket}`，默认 5 分钟一桶，共 60 桶 | 持续滚动 | 最早用量 5 小时后自动滚出；`resetAt` 返回「当前时刻 + 5 小时」，表示完全滚出的上界 |
| 自然日 | `...:day:{YYYYMMDD}` | 次日 0 点（Asia/Shanghai） | 与旧版日计数边界一致 |
| 自然月 | `...:month:{YYYYMM}` | 下月 1 日 0 点 | 月度额度不结转 |

- 5 小时窗口用 60 个 5 分钟桶求和，Redis 一次 `MGET` 完成；误差 ≤ 5 分钟。
- 日/月是单键计数，TTL 48h / 40 天。
- 窗口「先到先算」：任一窗口用尽即拒绝，错误里带 `window`。
- 入口判定是 `used >= limit`，因此**允许最后一轮略微超支**（一轮的量），下一轮拒绝。这是可用性与精度的折中；不接受超支可在入口加预估预留。

## 5. 共享池与例外

所有 AI 能力写同一个 token 池；非聊天能力按一次操作的估算值扣（图片附件只做准入检查，实际按本轮 usage 扣，失败不扣）：

| kind | 估算标准 token/次 | 说明 |
|---|---:|---|
| chat | 真实 usage | 缺失 usage 时按 `estimateTokens` 估算 |
| chat_anon | 真实 usage | 未登录按 IP 哈希桶 |
| chat_images | 2,000 / 张 | 仅准入检查；实际扣减按本轮 provider usage，避免重复计费 |
| generate | 8,000 / 批 | 出题 |
| grade | 3,000 / 次 | 批改 |
| kg_build | 30,000 / 次 | KG 构建 |
| vectorize | 600 / 分P | 向量化 |
| ocr | 1,500 / 张 | OCR |
| board | 2,500 / 次 | Board AI 补全 |
| academic_* | 2,000–30,000 | 科研分析/校验/导出/实验 |

例外（不是用量额度）：

- **coding_plan**：用户自带第三方套餐，不消耗平台 token / 不计平台成本；仍保留每日轮次上限（free 0 / vip 100 / svip 300），防止绕过会员档位滥用。
  **但 token 用量仍统计**：每轮按 provider 实际上报的 input + output 写入独立的 external 计数（5h / 日 / 月 + 今日按模型 + 轮次），
  在 `GET /quota/summary` 的 `codingPlan` 段返回，供账户页展示「Coding Plan 已用 token（今日 / 本月）」。
  这套计数与平台窗口完全隔离——只记账，不限额、不扣成本、不影响 Credits。
- **task_quiz_active**：活跃定时任务「存量」上限，不是消耗；仍按档位 2/10/30。

## 6. API 契约

`GET /quota/summary`（X-Uid 由网关注入；匿名按 IP 桶）：

```json
{
  "enabled": true,
  "tier": "vip",
  "tierSource": "app-pay",
  "unit": "token",
  "windows": [
    { "window": "five_hour", "used": 8000, "limit": 120000, "resetAt": 1760000000000, "usedPercent": 7, "remainingPercent": 93 },
    { "window": "day", "used": 8000, "limit": 600000, "resetAt": 1760000000000, "usedPercent": 1, "remainingPercent": 99 },
    { "window": "month", "used": 8000, "limit": 48000000, "resetAt": 1760000000000, "usedPercent": 0, "remainingPercent": 100 }
  ],
  "plan": {
    "priceYuan": 48,
    "monthlyTokens": 48000000,
    "valueYuan": 480,
    "bonus": 10,
    "referencePricePerMTok": 10,
    "fiveHourTokens": 120000,
    "dailyTokens": 600000
  },
  "planCatalog": [ { "tier": "free", "...": "..." }, { "tier": "vip", "...": "..." }, { "tier": "svip", "...": "..." } ],
  "kinds": [ { "kind": "chat", "used": 8000, "limit": -1, "resetAt": 1760000000000, "usedPercent": 1, "remainingPercent": 99 } ],
  "models": [ { "model": "z-ai/glm-5.3-flash", "inputWeight": 0.0188, "outputWeight": 0.648, "price": { "input": 0.188, "output": 6.48 } } ],
  "cost": { "microYuan": 0, "softMicroYuan": 0, "guardMicroYuan": 480000000, "guardEnabled": false, "level": "L0", "resetAt": 1760000000000 },
  "codingPlan": {
    "fiveHourTokens": 12000,
    "dayTokens": 36000,
    "monthTokens": 210000,
    "byModel": [ { "model": "opencode/zen-pro", "tokens": 30000 }, { "model": "kimi/k2-coding", "tokens": 6000 } ],
    "turns": 12
  },
  "storeUnavailable": false
}
```

`codingPlan` 为**追加字段**（向后兼容，老客户端忽略即可）：token 由用户自带第三方套餐支付，
不占平台 Credits；`byModel` 是今日按模型拆分（仅含后端进程见过的模型，token 总量不受影响），
`turns` 是今日已计量的 Coding Plan 轮次。匿名调用 / 未配置套餐 / `quota.enabled=false` 时该段为 0，
但**不受 `quota.enabled` 门禁影响**——只要用户走过 Coding Plan 就会记账。

聊天超额 SSE：

```json
{
  "type": "error",
  "code": "QUOTA_EXCEEDED",
  "message": "5 小时滚动 token 额度已用完（12 万 / 12 万），窗口重置后恢复",
  "detail": {
    "kind": "chat",
    "window": "five_hour",
    "unit": "token",
    "used": 120000,
    "limit": 120000,
    "resetAt": 1760000000000,
    "tier": "vip",
    "upgradeSku": "SVIP_MONTHLY"
  }
}
```

非聊天端点（board / KG / quiz）使用相同 `code` + `detail` 字段；HTTP 429。

## 7. 失败方向

| 故障 | 行为 | 原因 |
|---|---|---|
| Redis / 计数存储不可用 | **fail-open 放行**，响应 `storeUnavailable: true` | 可用性优先；一次 Redis 故障不能冻结全部聊天 |
| app-pay 档位查询失败 | **fail-closed 回落 free** | 防止支付故障期间超卖会员额度 |
| usage 缺失 | 按可见 prompt + 回答估算 | 不能静默免费 |
| 写额度失败 | 只记 warn，不影响本轮成功响应 | 计量是旁路 |
| 失败/重试轮次 | **不扣** | consume-on-success |
| 委派子 agent | usage 已由 harness 合并，不重复扣 | 一次扣费 |

## 8. 配置与运营调参

`app-ts/config/default.yaml`：

```yaml
quota:
  enabled: true
  referencePricePerMTok: 10
  planBonus: 10
  fiveHourMinutes: 300
  bucketMinutes: 5
  plans:
    free:  { priceYuan: 0,  monthlyTokens: 300000,    dailyTokens: 30000,     fiveHourTokens: 6000 }
    vip:    { priceYuan: 48,  monthlyTokens: 48000000,  dailyTokens: 1600000,   fiveHourTokens: 320000 }
    svip:   { priceYuan: 148, monthlyTokens: 148000000, dailyTokens: 4933333,   fiveHourTokens: 986667 }
    promax: { priceYuan: 248, monthlyTokens: 248000000, dailyTokens: 8266667,   fiveHourTokens: 1653333 }
  prices:
    "z-ai/glm-5.3-flash": { input: 0.188, output: 6.48 }
  modelWeights: {}          # 可选：显式覆盖权重
  kindTokenCost:
    generate: 8000
    grade: 3000
  limits:
    coding_plan: { free: 0, vip: 100, svip: 300, promax: 600 }
    task_quiz_active: { free: 2, vip: 10, svip: 30 }
```

调参顺序（重要）：

1. **先把 `prices` 校准为真实结算价**（元/百万 token）。权重默认由价格推导；价格不准，额度和成本账本都会失真。
2. 若要促销/协议价，只改 `modelWeights[model].{input,output}`，不改 `prices`（成本账本仍用真实价）。
3. 再调 `plans.*.{fiveHourTokens,dailyTokens,monthlyTokens}`；VIP/SVIP 默认「日 × 30 ≈ 月、5h × 5 ≈ 日」，free 月总额可更紧（默认 30 万，约 10 个满额日）。
4. 最后调 `kindTokenCost`（按真实操作的平均 token 用量校准；偏差大时会在某类能力上过早/过晚拒绝）。
5. `planBonus` 控制订阅价值倍率；改它只影响展示与额度，不改支付价格。

环境变量覆盖（loader 的 `SECTION__KEY` 规则，双下划线嵌套）：

```bash
QUOTA__PLAN_BONUS=10
QUOTA__REFERENCE_PRICE_PER_M_TOK=10
QUOTA__FIVE_HOUR_MINUTES=300
QUOTA__BUCKET_MINUTES=5
```

> `.env` 只放密钥；额度属于普通配置，优先改 YAML / 部署 override。

## 9. 存储与迁移

键空间：

```
mind-base:quota:tokens:{id}:5h:{epochBucket}
mind-base:quota:tokens:{id}:day:{YYYYMMDD}
mind-base:quota:tokens:{id}:month:{YYYYMM}
mind-base:quota:kind:{kind}:{id}:{YYYYMMDD}
mind-base:quota:cost:{id}:{YYYYMMDD}
mind-base:quota:coding_plan:{id}:{YYYYMMDD}          # 每日轮次上限（按次）
mind-base:quota:external:{id}:5h:{epochBucket}       # Coding Plan 实际 token：滚动 5h
mind-base:quota:external:{id}:day:{YYYYMMDD}         # Coding Plan 实际 token：自然日
mind-base:quota:external:{id}:month:{YYYYMM}         # Coding Plan 实际 token：自然月
mind-base:quota:external:{id}:turns:{YYYYMMDD}       # Coding Plan 今日已计量轮次
mind-base:quota:external:{id}:model:{YYYYMMDD}:{model}  # Coding Plan 今日按模型 token
```

`external:*` 是平台代付之外（Coding Plan）的独立账本：与 `tokens:*` / `cost:*` 完全隔离，
写入走 `QuotaService.recordExternalTurn`（provider 实际 usage，缺失时用与平台轮次同一套估算兜底），
因此统计 Coding Plan 用量不会移动任何平台额度窗口。

- `id` = uid，或匿名场景的 `sha256(ip)[:24]`。
- 旧版 `mind-base:quota:{kind}:{uid}:{day}` 计数键**不再读取**；新键从 0 开始，上线首日没有历史额度。
- 旧 `mind-base:quiz_quota:*` 跨栈计数只作为 app-content 未注入 quota 时的回落路径；app-ts 正常形态不再写它。
- 需要回滚：把 `quota.enabled` 置 false 即可放行；旧键仍在 Redis 中（TTL 到期自然清理）。

## 10. 已知边界

- 5 小时窗口是「滚动」而不是「固定 5 小时块」，所以 `resetAt` 是「完全滚出上界」，不是精确的恢复时刻；前端文案用「5 小时后完全滚出」避免误导。
- 非聊天能力的 token 是**估算**，不是 provider 真实 usage；后续可在各服务接 usage 回传后替换为真实值（接口不变，只改 `kindTokenCost`/调用点）。
- 入口判定允许最后一轮超支；极端并发下多轮可能同时通过 gate。要严格封顶需在 gate 做预估预留（当前选择可用性优先）。
- 模型价格表是配置，不是自动同步；网关调价后必须人工更新 `quota.prices`，否则成本/权重会漂移。
- 额度不结转：日/月窗口过期即清零（与 Kimi 一致）。
- Coding Plan 的 `byModel` 拆分依赖进程内见过的模型 id（Redis 计数键无法枚举）：进程重启后、下个 Coding Plan 轮次之前该数组可能暂时为空；5h/日/月/轮次总量始终来自计数键，不受影响。

## 11. 测试

```bash
cd app-ts
npm run typecheck
npx vitest run test/quota.test.ts test/quota-chat.test.ts test/quota-coding-plan.test.ts
npm test
```

覆盖：三层窗口与重置边界、5h 滚动、模型权重、成本整数运算、fail-open/fail-closed、匿名桶、图片批量、非聊天估算、coding_plan 次数例外、stock cap、summary 契约，以及 Coding Plan 实际 token 独立计量（不占平台窗口/成本、估算兜底、零/非法 usage、5h 滚动、按模型拆分、quota 关闭仍统计）。
