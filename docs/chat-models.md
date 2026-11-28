# 聊天模型选择（config/model.json）

> 代码：[`app-ts/src/config/chat-models.ts`](../app-ts/src/config/chat-models.ts)（目录加载/校验）、
> [`app-ts/src/transport/http/routes/chat.ts`](../app-ts/src/transport/http/routes/chat.ts)（GET /chat/models] + body 校验）、
> [`frontendv2/components/chat/chat-model-picker.tsx`](../frontendv2/components/chat/chat-model-picker.tsx)（前端选择器）。

## 1. 目录文件

`app-ts/config/model.json`：

```json
{
  "default": "z-ai/glm-5.3-flash",
  "models": [
    {
      "id": "z-ai/glm-5.3-flash",
      "label": "GLM-5.3 Flash",
      "description": "默认 · 快速通用，支持图片与长上下文",
      "vision": true
    },
    {
      "id": "z-ai/glm-5.3",
      "label": "GLM-5.3",
      "description": "更强推理；需确认 AI 网关已路由该模型",
      "vision": true
    }
  ]
}
```

- `default` 必填，且必须是 `models` 里的一项；不存在的模型不会被接受。
- `id` / `label` 必填且唯一；`description`、`vision` 可选（`vision` 用于图片发送前的门控）。
- 当前目录提供 **11 个 2026 年发布的模型**：GLM-5.3 Flash（默认）、OpenAI GPT-6.1 Terra / Sol / Terra Pro、Claude Sonnet 5.5、Gemini 4 Carbon、DeepSeek V4.1 Flash、Qwen3.8 Max Prime、Kimi K3.1 Pro、Grok 4.7；发布年份/日期写在 `description` 方便用户识别。
- 最多 20 个模型（防止前端选择器过大）。
- **所有模型都必须是 AI 网关（Higress / OpenAI 兼容口）已经路由的模型 ID**；app-ts 不保存任何供应商 key，模型调用统一使用 `AI_GATEWAY__API_KEY`。
- 目录缺失/JSON 非法/结构不合法时会告警并回退为单一默认模型 `config.llm.model`，聊天不中断。

## 2. 服务默认模型

`app-ts/config/default.yaml` 的 `llm.model` 仍是**服务默认基础模型**：

- 未传 `model` 的请求、标题生成、出题、摘要等后台任务继续使用它；
- `GET /chat/models` 返回的 `default` 来自 `model.json`，用于前端默认选中；两者建议保持一致。

## 3. API

```
GET /chat/models
→ { "default": "...", "models": [{ "id": "...", "label": "...", "description": "...", "vision": true }] }
```

聊天请求（`POST /chat/ask/stream` 等）body 可带：

```json
{ "model": "z-ai/glm-5.3" }
```

- 不传 = 目录 default / 服务默认；
- 传了目录外的 id → 400（不静默回退）；
- 带图片且选中模型 `vision: false` → 400，提示切换支持图片的模型；
- 该选择只影响本轮 LLM（main + 被委派的子 agent 共享），不影响后台标题/出题等任务。

## 4. 前端行为

- 输入栏「模型 ▾」：顶部「默认模型」= 不传 model；其余为目录模型（label/description/vision 徽标）。
- 选择写入 `localStorage`（`mindbase.chat.model`），刷新后保留；本地值不在目录则回退 default。
- `GET /chat/models` 失败时选择器隐藏，聊天继续按服务端默认模型发送，不阻塞。
- 模型选择随普通发送、排队消息实际发送、regenerate、edit 重问、交互回答统一生效。

### 4.1 推理强度（reasoning effort）

- 输入栏模型弹层底部是**连续滑杆 0–100**（不再只有 min/mid/high/max 四档）：
  0 = 最轻（绿色）→ 黄绿 → 琥珀 → 珊瑚 → 100 = 最强（紫色），可自由拖动/键盘微调，
  取值与标签写入 `localStorage`（`mindbase_reasoning_effort`；旧的 `min|mid|high|max`
  在读取时自动迁移为 0/33/66/100）。
- 请求字段 `reasoning_effort` 为 **0–100 的数字**；后端 `normalizeReasoningEffort`
  仍兼容旧的 `min|mid|high|max` 与数字字符串。app-ts 再按单调区间映射到网关支持的
  `reasoning_effort` 枚举（`<30 minimal` / `<55 low` / `<80 medium` / `≥80 high`），
  因此滑块是连续的，实际生效粒度受上游模型能力限制；不支持该字段的模型会忽略。
- 相关实现：`frontendv2/components/chat/effort-slider.tsx`、
  `app-ts/src/agent/reasoning-effort.ts`（单测 `app-ts/test/reasoning-effort.test.ts`）。

## 5. 新增/调整模型

1. 在 AI 网关控制台确认模型已配置路由（供应商 key 只在网关，不进 app-ts）。
2. 编辑 `app-ts/config/model.json`，加入模型 id/label（可选 description/vision）。
3. 重启 app-ts（目录在启动时加载）；前端无需重新构建（选择器每次挂载重新拉取）。
4. 若新模型需要不同计价，在 `app-ts/config/default.yaml` 的 `quota.prices` 增加价格（元/百万 token）。该价格同时用于成本账本和 token 额度权重（权重 = 单价 / `quota.referencePricePerMTok`）；可用 `quota.modelWeights` 覆盖额度权重。缺失时回退默认模型价（成本与权重都按默认模型，数字不准）。完整口径见 [ai-quota.md](ai-quota.md)。
