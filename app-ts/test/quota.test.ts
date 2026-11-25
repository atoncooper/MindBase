import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  QuotaService,
  estimateTokens,
  hashClientKey,
  modelQuotaRate,
  nextMidnight,
  nextMonthStart,
  quotaTokensFor,
  quotaWindowName,
} from "../src/services/quota.js";
import type { QuotaCounterStore } from "../src/repository/quota.js";
import { MemoryQuotaCounter } from "../src/repository/memory/quota-counter.js";
import { costMicroYuan } from "../src/repository/usage-ledger.js";
import { config } from "../src/config/index.js";

/**
 * Unified token quota tests: 5h rolling / day / month windows, model weights,
 * cost accounting, fail-open store semantics, anonymous buckets, and the
 * non-token exceptions (Coding Plan count cap + task stock cap).
 */

const savedQuota = structuredClone(config.quota);
// 2026-11: shipping default is quota.enabled=false (no token limits); these
// unit tests exercise the enforcement machinery, so opt in explicitly.
beforeEach(() => {
  config.quota.enabled = true;
});
afterEach(() => {
  config.quota = structuredClone(savedQuota);
});

/** Counter whose every read reports unavailable — the fail-open probe. */
function brokenCounter(): QuotaCounterStore {
  return {
    count: async () => null,
    sum: async () => null,
    consume: async () => null,
    add: async () => null,
    addMany: async () => null,
    close: async () => undefined,
  };
}

function makeService(opts: {
  tier?: string;
  now?: Date | (() => Date);
  counter?: QuotaCounterStore;
} = {}) {
  const counter = opts.counter ?? new MemoryQuotaCounter();
  const nowFn =
    typeof opts.now === "function" ? opts.now : opts.now ? () => opts.now as Date : undefined;
  const svc = new QuotaService({
    counter,
    resolveTier: async () => opts.tier ?? "free",
    now: nowFn,
  });
  return { svc, counter };
}

function setPlan(
  tier: "free" | "vip" | "svip",
  plan: { dailyTokens: number; fiveHourTokens: number; monthlyTokens?: number; priceYuan?: number },
): void {
  config.quota.plans[tier] = {
    priceYuan: plan.priceYuan ?? (tier === "free" ? 0 : tier === "vip" ? 18 : 48),
    monthlyTokens: plan.monthlyTokens ?? 1_000_000,
    dailyTokens: plan.dailyTokens,
    fiveHourTokens: plan.fiveHourTokens,
  };
}

/** Force a model to 1 quota token per raw token (deterministic charges). */
function useUnitModel(model = "test/unit"): string {
  config.quota.modelWeights[model] = { input: 1, output: 1 };
  return model;
}

describe("QuotaService token windows", () => {
  it("degrades free at the token percentage and hard-stops on the daily cap", async () => {
    setPlan("free", { dailyTokens: 1000, fiveHourTokens: 1_000_000, monthlyTokens: 1_000_000 });
    config.quota.degradeAtPercent.free = 50;
    const model = useUnitModel();
    const { svc } = makeService({ tier: "free" });

    const g1 = await svc.beginChatTurn("u1");
    expect(g1?.verdict).toBe("allow");
    expect(g1?.level).toBe("L0");
    await svc.completeChatTurn("u1", undefined, { inputTokens: 300, outputTokens: 0 }, model);

    const g2 = await svc.beginChatTurn("u1");
    expect(g2?.level).toBe("L0"); // 30%
    await svc.completeChatTurn("u1", undefined, { inputTokens: 300, outputTokens: 0 }, model);

    const g3 = await svc.beginChatTurn("u1");
    expect(g3?.level).toBe("L1"); // 60% ≥ 50%
    expect(g3?.verdict).toBe("allow");
    await svc.completeChatTurn("u1", undefined, { inputTokens: 400, outputTokens: 0 }, model);

    const g4 = await svc.beginChatTurn("u1");
    expect(g4?.verdict).toBe("quota_exceeded");
    expect(g4?.window).toBe("day");
    expect(g4?.used).toBe(1000);
    expect(g4?.limit).toBe(1000);
  });

  it("rolls usage out of the 5-hour window", async () => {
    setPlan("free", { dailyTokens: 1_000_000, fiveHourTokens: 1000, monthlyTokens: 10_000_000 });
    const model = useUnitModel();
    let clock = new Date("2026-11-20T02:00:00Z");
    const { svc } = makeService({ tier: "free", now: () => clock });

    await svc.completeChatTurn("u1", undefined, { inputTokens: 1200, outputTokens: 0 }, model);
    const blocked = await svc.beginChatTurn("u1");
    expect(blocked?.verdict).toBe("quota_exceeded");
    expect(blocked?.window).toBe("five_hour");

    clock = new Date("2026-11-20T08:01:00Z"); // > 5h later
    const rolled = await svc.beginChatTurn("u1");
    expect(rolled?.verdict).toBe("allow");
    expect(rolled?.windows?.find((w) => w.window === "five_hour")?.used).toBe(0);
  });

  it("resets the month window at local month start", async () => {
    setPlan("free", { dailyTokens: 1_000_000, fiveHourTokens: 1_000_000, monthlyTokens: 1000 });
    const model = useUnitModel();
    let clock = new Date("2026-11-20T04:00:00Z"); // Nov 20 12:00 Shanghai
    const { svc } = makeService({ tier: "free", now: () => clock });

    await svc.completeChatTurn("u1", undefined, { inputTokens: 1200, outputTokens: 0 }, model);
    const blocked = await svc.beginChatTurn("u1");
    expect(blocked?.verdict).toBe("quota_exceeded");
    expect(blocked?.window).toBe("month");

    clock = new Date("2026-11-30T16:00:01Z"); // Dec 1 00:00:01 Shanghai
    const fresh = await svc.beginChatTurn("u1");
    expect(fresh?.verdict).toBe("allow");
    expect(fresh?.windows?.find((w) => w.window === "month")?.used).toBe(0);
  });

  it("resets the day window at local midnight", async () => {
    setPlan("free", { dailyTokens: 500, fiveHourTokens: 1_000_000, monthlyTokens: 10_000_000 });
    const model = useUnitModel();
    let clock = new Date("2026-11-20T04:00:00Z");
    const { svc } = makeService({ tier: "free", now: () => clock });

    await svc.completeChatTurn("u1", undefined, { inputTokens: 600, outputTokens: 0 }, model);
    expect((await svc.beginChatTurn("u1"))?.verdict).toBe("quota_exceeded");

    clock = new Date("2026-11-20T16:00:01Z"); // next Shanghai midnight
    expect((await svc.beginChatTurn("u1"))?.verdict).toBe("allow");
  });
});

describe("model weights", () => {
  it("charges expensive models faster than cheap ones", () => {
    const cheap = modelQuotaRate("z-ai/glm-5.3-flash");
    const expensive = modelQuotaRate("openai/gpt-6.1-terra-pro");
    expect(cheap.inputWeight).toBeLessThan(expensive.inputWeight);
    expect(cheap.outputWeight).toBeLessThan(expensive.outputWeight);

    const usage = { inputTokens: 1000, outputTokens: 200 };
    expect(quotaTokensFor("openai/gpt-6.1-terra-pro", usage)).toBeGreaterThan(
      quotaTokensFor("z-ai/glm-5.3-flash", usage),
    );
  });

  it("honors explicit modelWeights overrides", () => {
    config.quota.modelWeights["test/discount"] = { input: 0.5, output: 0.25 };
    const rate = modelQuotaRate("test/discount");
    expect(rate.inputWeight).toBe(0.5);
    expect(rate.outputWeight).toBe(0.25);
    expect(quotaTokensFor("test/discount", { inputTokens: 100, outputTokens: 100 })).toBe(75);
  });

  it("falls back to the default model price for an unpriced model", () => {
    const rate = modelQuotaRate("unknown/model");
    expect(rate.inputWeight).toBe(modelQuotaRate(config.llm.model).inputWeight);
    expect(rate.outputWeight).toBe(modelQuotaRate(config.llm.model).outputWeight);
  });
});

describe("external models (Coding Plan)", () => {
  it("charges zero platform tokens and zero cost", async () => {
    config.quota.externalModels = ["plan/model"];
    setPlan("free", { dailyTokens: 1000, fiveHourTokens: 1000, monthlyTokens: 1_000_000 });
    const now = new Date("2026-11-20T04:00:00Z");
    const { svc } = makeService({ tier: "free", now });
    const charged = await svc.completeChatTurn(
      "u1",
      undefined,
      { inputTokens: 100000, outputTokens: 100000 },
      "plan/model",
    );
    expect(charged).toBe(0);
    const summary = await svc.summary("u1");
    expect(summary.windows.find((w) => w.window === "day")?.used).toBe(0);
    expect(summary.cost.microYuan).toBe(0);
  });
});

describe("cost accounting and estimation", () => {
  it("accumulates cost as tokens × price and charges normalized tokens", async () => {
    setPlan("free", { dailyTokens: 1_000_000, fiveHourTokens: 1_000_000, monthlyTokens: 10_000_000 });
    const now = new Date("2026-11-20T04:00:00Z");
    const { svc, counter } = makeService({ tier: "free", now });

    const charged = await svc.completeChatTurn(
      "u1",
      undefined,
      { inputTokens: 7000, outputTokens: 2000 },
      "z-ai/glm-5.3-flash",
    );
    // 7000×0.0188 + 2000×0.648 = 1427.6 → 1428
    expect(charged).toBe(1428);
    expect(await counter.count(svc.keyFor("chat", "u1", now))).toBe(1428);
    expect(await counter.count(svc.costKey("u1", now))).toBe(14276);
    expect(costMicroYuan(7000, 2000, config.quota.prices["z-ai/glm-5.3-flash"])).toBe(14276);
  });

  it("estimates CJK/Latin text for providers that omit usage", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("hello world")).toBe(3);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("optional cost backstop", () => {
  it("still blocks with cost_guard when explicitly enabled", async () => {
    config.quota.costGuardEnabled = true;
    config.quota.costGuardMicroYuan.free = 1;
    setPlan("free", { dailyTokens: 1_000_000, fiveHourTokens: 1_000_000, monthlyTokens: 10_000_000 });
    const { svc } = makeService({ tier: "free" });
    await svc.completeChatTurn(
      "u1",
      undefined,
      { inputTokens: 0, outputTokens: 1000 },
      "z-ai/glm-5.3-flash",
    );
    const gate = await svc.beginChatTurn("u1");
    expect(gate?.verdict).toBe("cost_guard");
  });
});

describe("QuotaService failure semantics", () => {
  it("fails OPEN when the counter store is unavailable", async () => {
    const { svc } = makeService({ tier: "free", counter: brokenCounter() });
    const gate = await svc.beginChatTurn("u1");
    expect(gate?.verdict).toBe("allow");
    expect(gate?.storeUnavailable).toBe(true);
  });

  it("fails CLOSED to the free tier when membership resolution misbehaves", async () => {
    setPlan("free", { dailyTokens: 100, fiveHourTokens: 100, monthlyTokens: 100 });
    const model = useUnitModel();
    const counter = new MemoryQuotaCounter();
    const svc = new QuotaService({ counter, resolveTier: async () => "platinum" });
    await svc.completeChatTurn("u1", undefined, { inputTokens: 100, outputTokens: 0 }, model);
    const gate = await svc.beginChatTurn("u1");
    expect(gate?.tier).toBe("free");
    expect(gate?.verdict).toBe("quota_exceeded");
  });
});

describe("anonymous bucketing", () => {
  it("meters chat_anon by clientKey and rejects over budget", async () => {
    setPlan("free", { dailyTokens: 500, fiveHourTokens: 500, monthlyTokens: 1_000_000 });
    const model = useUnitModel();
    const { svc } = makeService({ tier: "free" });
    const ip = hashClientKey("203.0.113.9");
    expect((await svc.beginChatTurn(undefined, ip))?.kind).toBe("chat_anon");
    await svc.completeChatTurn(undefined, ip, { inputTokens: 600, outputTokens: 0 }, model);
    expect((await svc.beginChatTurn(undefined, ip))?.verdict).toBe("quota_exceeded");
  });

  it("skips gating entirely for unattributable requests (no uid, no IP)", async () => {
    const { svc } = makeService({ tier: "free" });
    expect(await svc.beginChatTurn(undefined, undefined)).toBeNull();
  });
});

describe("shared pool: non-chat operations", () => {
  it("checks image batches against the remaining token budget without charging", async () => {
    setPlan("free", { dailyTokens: 6000, fiveHourTokens: 1_000_000, monthlyTokens: 1_000_000 });
    config.quota.kindTokenCost.chat_images = 2000;
    const model = useUnitModel();
    const { svc } = makeService({ tier: "free" });

    await svc.completeChatTurn("u1", undefined, { inputTokens: 4000, outputTokens: 0 }, model);
    expect(await svc.canConsume("u1", undefined, "chat_images", 2)).toBe(false); // 4000+4000 > 6000
    expect(await svc.canConsume("u1", undefined, "chat_images", 1)).toBe(true); // exact fit
    // check-only: the day counter is still 4000 (images are charged by actual usage later)
    const day = (await svc.summary("u1")).windows.find((w) => w.window === "day");
    expect(day?.used).toBe(4000);
  });

  it("peekKind/consumeKind charge estimated tokens, not counts", async () => {
    setPlan("free", { dailyTokens: 20000, fiveHourTokens: 20000, monthlyTokens: 1_000_000 });
    config.quota.kindTokenCost.generate = 8000;
    const now = new Date("2026-11-20T04:00:00Z");
    const { svc } = makeService({ tier: "free", now });

    expect((await svc.peekKind("u1", "generate"))?.verdict).toBe("allow");
    expect(await svc.consumeKind("u1", "generate")).toBe(true);
    expect(await svc.consumeKind("u1", "generate")).toBe(true);
    const over = await svc.peekKind("u1", "generate");
    expect(over?.verdict).toBe("quota_exceeded");
    expect(over?.limit).toBe(20000);
    expect(await svc.consumeKind("u1", "generate")).toBe(false);
    expect(await svc.summary("u1")).toMatchObject({ tier: "free" });
  });

  it("keeps the Coding Plan turn cap count-based and outside the token pool", async () => {
    config.quota.limits.coding_plan = { free: 1, vip: 100, svip: 300 };
    setPlan("free", { dailyTokens: 10_000, fiveHourTokens: 10_000, monthlyTokens: 1_000_000 });
    const { svc } = makeService({ tier: "free" });

    expect(await svc.consumeKind("u1", "coding_plan")).toBe(true);
    expect(await svc.consumeKind("u1", "coding_plan")).toBe(false);
    const summary = await svc.summary("u1");
    expect(summary.windows.find((w) => w.window === "day")?.used).toBe(0);
  });

  it("stockLimit returns the tier ceiling for stock caps", async () => {
    config.quota.limits.task_quiz_active = { free: 2, vip: 10, svip: 30 };
    const vip = makeService({ tier: "vip" });
    expect(await vip.svc.stockLimit("u1", "task_quiz_active")).toBe(10);
    const free = makeService({ tier: "free" });
    expect(await free.svc.stockLimit("u1", "task_quiz_active")).toBe(2);
  });
});

describe("summary and plan value", () => {
  it("reports three windows, plan value, model rates and per-kind tokens", async () => {
    setPlan("vip", { dailyTokens: 10000, fiveHourTokens: 10000, monthlyTokens: 18000000, priceYuan: 18 });
    const now = new Date("2026-11-09T04:00:00Z");
    const { svc } = makeService({ tier: "vip", now });
    await svc.completeChatTurn(
      "u1",
      undefined,
      { inputTokens: 100000, outputTokens: 0 },
      "z-ai/glm-5.3-flash",
    );

    const summary = await svc.summary("u1");
    expect(summary.unit).toBe("credit");
    expect(summary.windows.map((w) => w.window)).toEqual(["five_hour", "day", "month"]);
    expect(summary.plan.priceYuan).toBe(18);
    expect(summary.plan.valueYuan).toBe(180);
    expect(summary.plan.bonus).toBe(10);
    expect(summary.plan.monthlyTokens).toBe(18_000_000);
    expect(summary.models.length).toBeGreaterThan(0);
    expect(summary.planCatalog.map((p) => p.tier)).toEqual(["free", "vip", "svip", "promax"]);

    const day = summary.windows.find((w) => w.window === "day");
    expect(day?.limit).toBe(10000);
    expect(day?.used).toBeGreaterThan(0);
    const chat = summary.kinds.find((k) => k.kind === "chat");
    expect(chat?.used).toBeGreaterThan(0);
    expect(chat?.limit).toBe(-1);
  });

  it("derives monthly tokens from price × bonus when monthlyTokens is omitted", () => {
    config.quota.plans.vip = {
      priceYuan: 18,
      dailyTokens: 1000,
      fiveHourTokens: 1000,
    } as (typeof config.quota.plans)["vip"];
    const { svc } = makeService({ tier: "vip" });
    return svc.summary("u1").then((s) => {
      expect(s.plan.monthlyTokens).toBe(18_000_000);
      expect(s.plan.valueYuan).toBe(180);
    });
  });
});

describe("keys and boundaries", () => {
  // 2026-10-14T18:00Z = 2026-10-15 02:00 Shanghai
  const now = new Date("2026-10-14T18:00:00Z");

  it("keys kinds on the Shanghai calendar day", () => {
    const { svc } = makeService({ now });
    expect(svc.keyFor("chat", "123", now)).toBe("mind-base:quota:kind:chat:123:20261015");
    expect(svc.keyFor("generate", "123", now)).toBe("mind-base:quota:kind:generate:123:20261015");
  });

  it("resetAt helpers use Shanghai midnight / month start", () => {
    expect(nextMidnight(now)).toBe(Date.UTC(2026, 9, 15, 16, 0, 0));
    // Nov 1 00:00 Shanghai = Oct 31 16:00Z
    expect(nextMonthStart(new Date("2026-10-14T18:00:00Z"))).toBe(Date.UTC(2026, 9, 31, 16, 0, 0));
  });

  it("labels windows for error messages", () => {
    expect(quotaWindowName("five_hour")).toContain("5 小时");
    expect(quotaWindowName("month")).toBe("本月");
  });
});
