import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { randomUUID } from "node:crypto";
import { config } from "../config/index.js";
import { getRequestContext } from "../context/request-context.js";

/**
 * LLM provider factory: all AI traffic goes through the Higress gateway (OpenAI-compatible /v1).
 * Mirrors Python `build_platform_llm`: purpose is the billing label, passed via a custom header for gateway-side usage attribution.
 * requestId/uid are taken from the request context first (ALS, propagated through the chain); self-generated when there is no request context (boot/background tasks).
 *
 * Red line: provider keys live only in the gateway; this side only holds the gateway consumer key.
 */
export interface LlmRequestOptions {
  /** Billing label for the business purpose, e.g. chat / rag_summary / quiz */
  purpose: string;
  /** User uid for gateway-side usage attribution; absent = platform call */
  uid?: string;
  requestId?: string;
  temperature?: number;
}

export function createGatewayModel(
  purpose: string,
  opts: { uid?: string; temperature?: number; requestId?: string; model?: string; apiKey?: string } = {},
) {
  const ctx = getRequestContext();
  const requestId = opts.requestId ?? ctx?.requestId ?? randomUUID();
  const uid = opts.uid ?? ctx?.uid;
  const provider = createOpenAICompatible({
    name: "higress",
    baseURL: config.aiGateway.baseUrl,
    apiKey: opts.apiKey ?? config.aiGateway.apiKey,
    // generateObject 走 JSON Schema 结构化输出（json_schema response_format）：
    // GLM 对 schema 遵循度好且显著快于默认的 json_object+prompt 内联模式——
    // 后者是出题批次慢/挂起/解析失败的根因。chat/streamText 不传 responseFormat，
    // 不受此开关影响。
    supportsStructuredOutputs: true,
    headers: {
      "X-Request-Id": requestId,
      "X-Purpose": purpose,
      ...(opts.uid !== undefined ? { "x-uid": String(opts.uid) } : {}),
    },
  });
  return provider.chatModel(opts.model ?? config.llm.model);
}

/** Default params for a meta LLM call (low-temperature scenarios like the router) */
export function defaultModelOptions(opts: Partial<LlmRequestOptions> = {}): {
  purpose: string;
  uid?: string;
  temperature?: number;
} {
  return {
    purpose: opts.purpose ?? "chat",
    uid: opts.uid,
    temperature: opts.temperature ?? config.llm.temperature,
  };
}
