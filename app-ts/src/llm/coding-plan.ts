import { createHash } from "node:crypto";
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
  /** true = the user marked this plan as the chat default. */
  is_default?: boolean;
}

export type CodingPlanProtocol = "openai" | "anthropic";

/**
 * Validate/normalize the internal plan before it becomes a model.
 * Throws a key-free message so the caller can fall back to the platform gateway.
 *
 * Provider base URLs are owned by app-user's YAML catalog; the internal M2M
 * face already returns the effective (current) base for legacy rows.
 */
export function normalizeCodingPlan(plan: CodingPlan): CodingPlan {
  const label =
    (typeof plan?.label === "string" && plan.label.trim()) ||
    (typeof plan?.id === "string" && plan.id) ||
    "coding-plan";
  const rawBaseUrl = typeof plan?.base_url === "string" ? plan.base_url.trim().replace(/\/+$/, "") : "";
  if (!rawBaseUrl) {
    throw new Error(`coding plan "${label}" has an empty base_url`);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new Error(`coding plan "${label}" has an invalid base_url`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`coding plan "${label}" base_url must be http(s)`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`coding plan "${label}" base_url must not embed credentials`);
  }
  const protocol = typeof plan?.protocol === "string" ? plan.protocol.trim().toLowerCase() : "";
  if (protocol !== "openai" && protocol !== "anthropic") {
    throw new Error(`coding plan "${label}" has an unsupported protocol`);
  }
  const model = typeof plan?.model === "string" ? plan.model.trim() : "";
  if (!model) {
    throw new Error(`coding plan "${label}" has an empty model`);
  }
  const apiKey = typeof plan?.api_key === "string" ? plan.api_key.trim() : "";
  if (!apiKey) {
    throw new Error(`coding plan "${label}" has an empty api_key`);
  }
  return { ...plan, protocol, base_url: rawBaseUrl, model, api_key: apiKey };
}

/**
 * OpenCode requires a stable per-conversation session header and asks clients
 * to identify themselves with their own User-Agent. Only OpenCode plans get
 * these headers; other providers never see them.
 *
 * The session id is the chat session (passed from ChatService) or, for paths
 * without a chat session, a stable plan-scoped fallback.
 */
const OPENCODE_BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * OpenCode validates x-opencode-session as `ses_` + 12 hex + 14 base62.
 * Derive that shape deterministically from the (stable) chat session id so
 * every turn in one conversation reuses the same routing/cache key.
 */
export function opencodeSessionId(seed: string): string {
  const digest = createHash("sha256").update(seed).digest();
  const hex = digest.subarray(0, 6).toString("hex");
  const base62 = Array.from(digest.subarray(6, 20))
    .map((b) => OPENCODE_BASE62[b % 62])
    .join("");
  return `ses_${hex}${base62}`;
}

export function codingPlanRequestHeaders(
  plan: CodingPlan,
  sessionId?: string,
): Record<string, string> | undefined {
  const provider = String(plan?.provider ?? "").toLowerCase();
  let isOpenCode = provider.startsWith("opencode");
  if (!isOpenCode) {
    try {
      isOpenCode = new URL(String(plan?.base_url ?? "")).hostname === "opencode.ai";
    } catch {
      isOpenCode = false;
    }
  }
  if (!isOpenCode) return undefined;
  const seed = (sessionId ?? "").trim() || `coding-plan-${String(plan?.id ?? "session")}`;
  return {
    "x-opencode-session": opencodeSessionId(seed),
    "User-Agent": "MindBase/1.0 (coding-plan)",
  };
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
export function createCodingPlanModel(
  plan: CodingPlan,
  options: { sessionId?: string } = {},
): LanguageModel {
  const normalized = normalizeCodingPlan(plan);
  const headers = codingPlanRequestHeaders(normalized, options.sessionId);
  if (normalized.protocol === "anthropic") {
    // Anthropic's baseURL convention includes /v1 (the SDK appends /messages).
    return createAnthropic({
      baseURL: normalized.base_url,
      apiKey: normalized.api_key,
      ...(headers ? { headers } : {}),
    })(normalized.model);
  }
  return createOpenAICompatible({
    name: "coding-plan",
    baseURL: normalized.base_url,
    apiKey: normalized.api_key,
    ...(headers ? { headers } : {}),
  }).chatModel(normalized.model);
}
