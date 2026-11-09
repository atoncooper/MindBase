import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * "Coding Plan" models: a VIP/SVIP user's own third-party subscription
 * (opencode / kimi / custom), served by app-user's settings-domain internal face.
 *
 * The plan arrives as snake_case (Go wire format) and only ever exists in
 * memory: app-user encrypts api_key at rest and never returns it over the user
 * API, so the plaintext key here must never be logged or persisted.
 */

/** Wire shape of GET /internal/settings/coding-plan/{uid} (plaintext api_key only in this M2M response). */
export interface CodingPlan {
  /** app-user's snowflake id (Go int64 → JSON number; kept loose for wire drift). */
  id: string | number;
  /** opencode | kimi | custom (informational; routing is driven by protocol) */
  provider: string;
  /** openai | anthropic */
  protocol: string;
  label: string;
  base_url: string;
  model: string;
  /** Plaintext credential — write-only: never include it in logs. */
  api_key: string;
}

export type CodingPlanProtocol = "openai" | "anthropic";

/**
 * Validate/normalize the internal plan before it becomes a model.
 * Throws a key-free message so the caller can fall back to the platform gateway.
 */
export function normalizeCodingPlan(plan: CodingPlan): CodingPlan {
  const label =
    (typeof plan?.label === "string" && plan.label.trim()) ||
    (typeof plan?.id === "string" && plan.id) ||
    "coding-plan";
  const baseUrl = typeof plan?.base_url === "string" ? plan.base_url.trim().replace(/\/+$/, "") : "";
  if (!baseUrl) {
    throw new Error(`coding plan "${label}" has an empty base_url`);
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`coding plan "${label}" has an invalid base_url`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`coding plan "${label}" base_url must be http(s)`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`coding plan "${label}" base_url must not embed credentials`);
  }
  const model = typeof plan?.model === "string" ? plan.model.trim() : "";
  if (!model) {
    throw new Error(`coding plan "${label}" has an empty model`);
  }
  const protocol = typeof plan?.protocol === "string" ? plan.protocol.trim().toLowerCase() : "";
  if (protocol !== "openai" && protocol !== "anthropic") {
    throw new Error(`coding plan "${label}" has an unsupported protocol`);
  }
  const apiKey = typeof plan?.api_key === "string" ? plan.api_key.trim() : "";
  if (!apiKey) {
    throw new Error(`coding plan "${label}" has an empty api_key`);
  }
  return { ...plan, protocol, base_url: baseUrl, model, api_key: apiKey };
}

/**
 * Build a LanguageModel from an internal Coding Plan.
 *
 * - protocol=openai    → OpenAI-compatible chat model (opencode / custom)
 * - protocol=anthropic → native Anthropic Messages API (kimi / custom)
 *
 * base_url must be http(s), model non-empty; invalid input throws and the
 * caller falls back to the gateway model.
 */
export function createCodingPlanModel(plan: CodingPlan): LanguageModel {
  const normalized = normalizeCodingPlan(plan);
  if (normalized.protocol === "anthropic") {
    // Anthropic's baseURL convention includes /v1 (the SDK appends /messages).
    return createAnthropic({
      baseURL: normalized.base_url,
      apiKey: normalized.api_key,
    })(normalized.model);
  }
  return createOpenAICompatible({
    name: "coding-plan",
    baseURL: normalized.base_url,
    apiKey: normalized.api_key,
  }).chatModel(normalized.model);
}
