import { describe, it, expect, afterEach, vi } from "vitest";
import { simulateReadableStream, type LanguageModelV2StreamPart } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import {
  createCodingPlanModel,
  normalizeCodingPlan,
  type CodingPlan,
} from "../src/llm/coding-plan.js";
import { createCodingPlanResolver, type CodingPlanResolverDeps } from "../src/agent/code/coding-plan-resolver.js";
import { createReactAgent } from "../src/agent/react.js";
import type { AgentRuntime } from "../src/tools/runtime.js";
import { AppUserAuthClient, AppUserAuthError } from "../src/auth/app-user-auth-client.js";
import { QuotaService } from "../src/services/quota.js";
import { MemoryQuotaCounter } from "../src/repository/memory/quota-counter.js";
import { config } from "../src/config/index.js";

/**
 * Coding Plan wiring (app-ts side):
 *  - factory maps protocol → OpenAI-compatible / Anthropic model, validates base_url/model
 *  - resolver falls back to the gateway on every unavailable path
 *  - daily coding_plan quota is consumed per use (free=0, VIP/SVIP only)
 *  - internal M2M client: 200 plan / 404 null / other statuses throw, 30s cache
 */

const basePlan: CodingPlan = {
  id: "plan-1",
  provider: "opencode",
  protocol: "openai",
  label: "我的 Coding Plan",
  base_url: "https://api.example.com/v1/",
  model: "gpt-4o-mini",
  api_key: "sk-super-secret-key",
};

interface CapturedLog {
  infos: Array<{ fields: Record<string, unknown>; message: string }>;
  warns: string[];
}

function silentLog(): CapturedLog & CodingPlanResolverDeps["logger"] {
  const infos: CapturedLog["infos"] = [];
  const warns: string[] = [];
  return {
    infos,
    warns,
    info: (fields, message) => infos.push({ fields, message }),
    warn: (message) => warns.push(message),
  };
}

const savedQuota = structuredClone(config.quota);
afterEach(() => {
  config.quota = structuredClone(savedQuota);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Coding Plan model factory", () => {
  it("openai protocol → OpenAI-compatible chat model (base_url trailing slash trimmed)", () => {
    const model = createCodingPlanModel(basePlan) as unknown as { modelId: string; provider: string };
    expect(model.modelId).toBe("gpt-4o-mini");
    expect(String(model.provider)).toContain("coding-plan");
    expect(normalizeCodingPlan(basePlan).base_url).toBe("https://api.example.com/v1");
  });

  it("anthropic protocol → Anthropic Messages model via @ai-sdk/anthropic", () => {
    const model = createCodingPlanModel({
      ...basePlan,
      provider: "kimi",
      protocol: "anthropic",
      base_url: "https://api.moonshot.cn/anthropic",
      model: "kimi-k2-0905-preview",
    }) as unknown as { modelId: string; provider: string };
    expect(model.modelId).toBe("kimi-k2-0905-preview");
    expect(String(model.provider)).toContain("anthropic");
  });

  it("rejects non-http(s) / invalid base_url and empty model (key-free error messages)", () => {
    for (const plan of [
      { ...basePlan, base_url: "ftp://api.example.com/v1" },
      { ...basePlan, base_url: "not a url" },
      { ...basePlan, model: "   " },
      { ...basePlan, protocol: "grpc" },
      { ...basePlan, api_key: "" },
    ]) {
      let message = "";
      try {
        createCodingPlanModel(plan);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(basePlan.api_key);
    }
  });
});

describe("Coding Plan resolver", () => {
  function make(opts: {
    plan?: CodingPlan | null;
    lookupError?: Error;
    allowed?: boolean;
    quotaError?: Error;
  }) {
    const looks: string[] = [];
    const consumed: Array<{ uid: string; kind: string }> = [];
    const log = silentLog();
    const resolver = createCodingPlanResolver({
      plans: {
        getCodingPlan: async (uid) => {
          looks.push(uid);
          if (opts.lookupError) throw opts.lookupError;
          return opts.plan === undefined ? basePlan : opts.plan;
        },
      },
      quota: {
        consumeKind: async (uid, kind) => {
          consumed.push({ uid, kind });
          if (opts.quotaError) throw opts.quotaError;
          return opts.allowed ?? true;
        },
      },
      logger: log,
    });
    return { resolver, looks, consumed, log };
  }

  it("returns the plan model, consumes coding_plan quota once, and audits uid/plan/provider/model without the key", async () => {
    const { resolver, consumed, log } = make({});
    const model = await resolver({ uid: "42" });
    expect(model).toBeDefined();
    expect(consumed).toEqual([{ uid: "42", kind: "coding_plan" }]);
    expect(log.infos).toHaveLength(1);
    expect(log.infos[0].message).toContain("[CODING_PLAN]");
    expect(log.infos[0].fields).toMatchObject({
      uid: "42",
      plan_id: "plan-1",
      provider: "opencode",
      model: "gpt-4o-mini",
    });
    expect(JSON.stringify(log)).not.toContain(basePlan.api_key);
  });

  it("no uid → gateway, no lookup / no quota consumption", async () => {
    const { resolver, looks, consumed } = make({});
    expect(await resolver({})).toBeUndefined();
    expect(looks).toHaveLength(0);
    expect(consumed).toHaveLength(0);
  });

  it("404 (null plan) → gateway, quota not consumed", async () => {
    const { resolver, consumed } = make({ plan: null });
    expect(await resolver({ uid: "42" })).toBeUndefined();
    expect(consumed).toHaveLength(0);
  });

  it("non-VIP (403) → gateway silently (expected no-plan path, no warning spam)", async () => {
    const { resolver, consumed, log } = make({ lookupError: new AppUserAuthError(403, "vip required") });
    expect(await resolver({ uid: "42" })).toBeUndefined();
    expect(consumed).toHaveLength(0);
    expect(log.warns).toHaveLength(0);
  });

  it("membership outage (503) → gateway + warning, without failing the turn", async () => {
    const { resolver, consumed, log } = make({ lookupError: new AppUserAuthError(503, "membership unavailable") });
    expect(await resolver({ uid: "42" })).toBeUndefined();
    expect(consumed).toHaveLength(0);
    expect(log.warns.join("\n")).toContain("fallback gateway");
  });

  it("quota exhausted → gateway + warning, no audit use line", async () => {
    const { resolver, log } = make({ allowed: false });
    expect(await resolver({ uid: "42" })).toBeUndefined();
    expect(log.infos).toHaveLength(0);
    expect(log.warns.join("\n")).toContain("quota exhausted");
  });

  it("quota layer failure → gateway (never route to third party uncontrolled)", async () => {
    const { resolver, log } = make({ quotaError: new Error("redis down") });
    expect(await resolver({ uid: "42" })).toBeUndefined();
    expect(log.infos).toHaveLength(0);
    expect(log.warns.join("\n")).toContain("quota check failed");
  });

  it("invalid plan (bad base_url) → gateway and quota is NOT consumed", async () => {
    const { resolver, consumed, log } = make({ plan: { ...basePlan, base_url: "ftp://bad" } });
    expect(await resolver({ uid: "42" })).toBeUndefined();
    expect(consumed).toHaveLength(0);
    expect(log.warns.join("\n")).toContain("invalid plan");
  });

  it("real QuotaService: VIP daily cap enforced, over-limit falls back to the gateway", async () => {
    config.quota.enabled = true;
    config.quota.limits.coding_plan = { free: 0, vip: 2, svip: 300 };
    const quota = new QuotaService({ counter: new MemoryQuotaCounter(), resolveTier: async () => "vip" });
    const log = silentLog();
    const resolver = createCodingPlanResolver({ plans: { getCodingPlan: async () => basePlan }, quota, logger: log });

    expect(await resolver({ uid: "42" })).toBeDefined();
    expect(await resolver({ uid: "42" })).toBeDefined();
    expect(await resolver({ uid: "42" })).toBeUndefined(); // 3rd use exceeds vip=2
    expect(log.infos).toHaveLength(2);
    expect(log.warns.join("\n")).toContain("quota exhausted");
  });

  it("real QuotaService: free tier cannot use coding_plan (limit 0)", async () => {
    config.quota.enabled = true;
    config.quota.limits.coding_plan = { free: 0, vip: 100, svip: 300 };
    const quota = new QuotaService({ counter: new MemoryQuotaCounter(), resolveTier: async () => "free" });
    const log = silentLog();
    const resolver = createCodingPlanResolver({ plans: { getCodingPlan: async () => basePlan }, quota, logger: log });
    expect(await resolver({ uid: "7" })).toBeUndefined();
    expect(log.infos).toHaveLength(0);
  });
});

describe("ReactAgent.resolveModel", () => {
  it("awaits the coding plan resolver once per run and streams with that model", async () => {
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: 0,
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "r1", modelId: "mock-plan", timestamp: new Date() },
            { type: "text-start", id: "t0" },
            { type: "text-delta", id: "t0", delta: "来自 Coding Plan 的回答" },
            { type: "text-end", id: "t0" },
            { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ] as LanguageModelV2StreamPart[],
        }),
      }),
    });
    let calls = 0;
    const agent = createReactAgent({
      name: "code",
      description: "code",
      runtime: { buildSdkTools: () => ({}) } as unknown as AgentRuntime,
      toolNames: [],
      purpose: "code",
      buildSystemPrompt: async () => "sys",
      resolveModel: async () => {
        calls += 1;
        return model;
      },
    });
    const frames = [];
    for await (const frame of agent.run({ query: "写一段快排", uid: "42", scope: {}, history: [] })) {
      frames.push(frame);
    }
    expect(calls).toBe(1);
    expect(frames.some((f) => f.type === "chunk" && f.content === "来自 Coding Plan 的回答")).toBe(true);
    expect(frames.some((f) => f.type === "error")).toBe(false);
  });
});

describe("AppUserAuthClient.getCodingPlan", () => {
  // Coding Plan is served by app-user's SETTINGS listener (8015), not the auth
  // listener — the base URL comes from config.appUserSettings.
  function makeClient() {
    return new AppUserAuthClient({
      baseUrl: "http://app-user-auth.test",
      apiKey: "internal-key",
      timeoutMs: 1000,
      settingsBaseUrl: "http://app-user.test",
      settingsApiKey: "internal-key",
      settingsTimeoutMs: 1000,
    });
  }

  it("200 → plan and the request carries apikey", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ plan: basePlan }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const plan = await makeClient().getCodingPlan("42");
    expect(plan).toMatchObject({ id: "plan-1", model: "gpt-4o-mini" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://app-user.test/internal/settings/coding-plan/42");
    expect((init.headers as Record<string, string>).apikey).toBe("internal-key");
  });

  it("404 → null and the null answer is cached for 30s", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail: "no plan" }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = makeClient();
    expect(await client.getCodingPlan("42")).toBeNull();
    expect(await client.getCodingPlan("42")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("200 answer is cached (no duplicate M2M call)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ plan: basePlan }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = makeClient();
    await client.getCodingPlan("42");
    await client.getCodingPlan("42");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("403 non-VIP / 503 membership outage → throws so the caller falls back to the gateway", async () => {
    for (const status of [403, 503]) {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail: "nope" }), { status }));
      vi.stubGlobal("fetch", fetchMock);
      const client = makeClient();
      await expect(client.getCodingPlan("42")).rejects.toMatchObject({ status });
      await expect(client.getCodingPlan("42")).rejects.toBeInstanceOf(AppUserAuthError);
      expect(fetchMock).toHaveBeenCalledTimes(2); // errors are not cached
    }
  });
});
