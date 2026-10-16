/**
 * Spike: GLM thinking 开关经 Higress 网关的透传验证（一次性脚本，不进产品路径）。
 *
 * 背景与目标见 config quota 注释：L1 省流当前靠「缩上下文 + 输出预算 2048」；
 * 若上游支持 thinking 关闭，L1 的输出成本可再降一档（思考 token 计入输出价）。
 *
 * 验证四个变体（各 3 次取均值，非流式 chat/completions）：
 *   baseline          —— 现状（思考开启）
 *   thinking_disabled —— GLM 原生：thinking: { type: "disabled" }
 *   reasoning_off     —— OpenRouter 统一：reasoning: { enabled: false }
 *   effort_low        —— OpenAI 风格：reasoning_effort: "low"（SDK 内建映射）
 *
 * 判定：变体生效 = ① HTTP 200；② 响应无 reasoning_content（流式无 reasoning delta）；
 *       ③ completion_tokens 相对 baseline 显著下降。
 * 结果解读：
 *   - 某变体 200 且 tokens 降 → 该参数全链路可用，按此接线（providerOptions.higress）；
 *   - 200 但 tokens 不降     → 字段被网关吞掉或上游不认 → 查 Higress AI-proxy 转发 /
 *     换 Z.ai 直连 provider（native key），或维持现 L1 口径；
 *   - 4xx                    → 上游拒绝该字段 → 换下一变体。
 *
 * 运行（需 Higress 栈在跑：docker compose --profile ai up -d higress）：
 *   node node_modules/tsx/dist/cli.mjs scripts/spike-thinking.ts
 */

import { config } from "../src/config/index.js";

const MODEL = config.llm.model;
const BASE = config.aiGateway.baseUrl.replace(/\/$/, "");
const PROMPT = "9.11 和 9.8 哪个大？请一步步推理后给出结论。";
const RUNS = 3;

interface Variant {
  name: string;
  extra: Record<string, unknown>;
}

const VARIANTS: Variant[] = [
  { name: "baseline", extra: {} },
  { name: "thinking_disabled", extra: { thinking: { type: "disabled" } } },
  { name: "reasoning_off", extra: { reasoning: { enabled: false } } },
  { name: "effort_low", extra: { reasoning_effort: "low" } },
];

async function callOnce(extra: Record<string, unknown>): Promise<{
  status: number; completionTokens: number; promptTokens: number; hasReasoning: boolean; error?: string;
}> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.aiGateway.apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: PROMPT }],
      ...extra,
    }),
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, completionTokens: -1, promptTokens: -1, hasReasoning: false, error: text.slice(0, 200) };
  const json = JSON.parse(text) as {
    choices?: Array<{ message?: { reasoning_content?: string } }>;
    usage?: { completion_tokens?: number; prompt_tokens?: number };
  };
  return {
    status: res.status,
    completionTokens: json.usage?.completion_tokens ?? -1,
    promptTokens: json.usage?.prompt_tokens ?? -1,
    hasReasoning: Boolean(json.choices?.[0]?.message?.reasoning_content),
  };
}

async function main(): Promise<void> {
  console.log(`spike-thinking: model=${MODEL} gateway=${BASE} runs=${RUNS}/variant`);
  const rows: Array<{ name: string; status: number; avgCompletion: number; hasReasoning: boolean; note: string }> = [];
  for (const variant of VARIANTS) {
    const samples: number[] = [];
    let hasReasoning = false;
    let lastStatus = 0;
    let lastError = "";
    for (let i = 0; i < RUNS; i += 1) {
      try {
        const r = await callOnce(variant.extra);
        lastStatus = r.status;
        if (r.error) lastError = r.error;
        if (r.status === 200 && r.completionTokens >= 0) samples.push(r.completionTokens);
        hasReasoning = hasReasoning || r.hasReasoning;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : -1;
    rows.push({
      name: variant.name,
      status: lastStatus,
      avgCompletion: Math.round(avg),
      hasReasoning,
      note: lastError ? `err: ${lastError}` : samples.length < RUNS ? "部分失败" : "",
    });
  }

  const baseline = rows.find((r) => r.name === "baseline");
  console.log("\nvariant            | http | avg completion_tokens | reasoning_content | vs baseline");
  console.log("-------------------|------|----------------------|-------------------|------------");
  for (const r of rows) {
    const delta = baseline && baseline.avgCompletion > 0 && r.avgCompletion >= 0
      ? `${Math.round((1 - r.avgCompletion / baseline.avgCompletion) * 100)}%↓`
      : "-";
    console.log(
      `${r.name.padEnd(19)}| ${String(r.status).padEnd(4)} | ${String(r.avgCompletion).padEnd(20)} | ${String(r.hasReasoning).padEnd(17)} | ${delta}${r.note ? `  (${r.note})` : ""}`,
    );
  }
  console.log("\n判定：某变体 200 + reasoning_content=false + tokens 显著下降 → 该参数全链路可用；");
  console.log("200 但 tokens 不降 → 网关吞字段或上游不认；4xx → 上游拒绝，换下一变体。");
}

void main();
