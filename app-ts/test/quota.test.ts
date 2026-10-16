import { describe, it, expect, afterEach } from "vitest";
import { QuotaService, hashClientKey, nextMidnight } from "../src/services/quota.js";
import type { QuotaCounterStore } from "../src/repository/quota.js";
import { MemoryQuotaCounter } from "../src/repository/memory/quota-counter.js";
import { costMicroYuan } from "../src/repository/usage-ledger.js";
import { config } from "../src/config/index.js";

/**
 * QuotaService unit tests: tier ladder, cost soft/guard,
 * fail-open on store errors, anon bucketing, legacy app-quiz key format,
 * and the Shanghai-midnight reset boundary.
 */

const savedQuota = structuredClone(config.quota);
afterEach(() => {
  // 重新克隆：直接回赋同一引用会让后续测试的修改穿透「保存副本」
  config.quota = structuredClone(savedQuota);
});

/** Counter whose every read reports unavailable — the fail-open probe. */
function brokenCounter(): QuotaCounterStore {
  return {
    count: async () => null,
    consume: async () => null,
    add: async () => null,
    close: async () => undefined,
  };
}

function makeService(opts: { tier?: string; now?: Date; counter?: QuotaCounterStore } = {}) {
  const counter = opts.counter ?? new MemoryQuotaCounter();
  const svc = new QuotaService({
    counter,
    resolveTier: async () => opts.tier ?? "free",
    now: opts.now ? () => opts.now! : undefined,
  });
  return { svc, counter };
}

describe("QuotaService free ladder", () => {
  it("runs L0 for the first l0Turns, L1 after, hard-stops at the limit", async () => {
    config.quota.limits.chat = { free: 3, vip: 100, svip: 300 };
    config.quota.freeLadder.l0Turns = 2;
    const { svc } = makeService({ tier: "free" });

    const g1 = await svc.beginChatTurn("u1");
    expect(g1?.verdict).toBe("allow");
    expect(g1?.level).toBe("L0");
    await svc.completeChatTurn("u1", undefined, undefined, "z-ai/glm-5.3-flash");

    const g2 = await svc.beginChatTurn("u1");
    expect(g2?.level).toBe("L0"); // count=1 < l0Turns=2
    await svc.completeChatTurn("u1", undefined, undefined, "z-ai/glm-5.3-flash");

    const g3 = await svc.beginChatTurn("u1");
    expect(g3?.verdict).toBe("allow");
    expect(g3?.level).toBe("L1"); // count=2 ≥ l0Turns → degrade
    await svc.completeChatTurn("u1", undefined, undefined, "z-ai/glm-5.3-flash");

    const g4 = await svc.beginChatTurn("u1");
    expect(g4?.verdict).toBe("quota_exceeded"); // count=3 = limit
    expect(g4?.used).toBe(3);
  });
});

describe("QuotaService cost ladder", () => {
  it("flips members to L1 when the day cost crosses the soft threshold", async () => {
    config.quota.costSoftMicroYuan.vip = 1000; // 0.001 元
    const { svc } = makeService({ tier: "vip" });
    // 10000 input tokens × 0.188 元/Mtok = 1880 microYuan ≥ 1000
    await svc.completeChatTurn("u1", undefined, { inputTokens: 10000, outputTokens: 0 }, "z-ai/glm-5.3-flash");
    const gate = await svc.beginChatTurn("u1");
    expect(gate?.verdict).toBe("allow");
    expect(gate?.level).toBe("L1");
    expect(gate?.costMicroYuan).toBe(1880);
  });

  it("cost guard (when enabled) blocks everything for the rest of the day", async () => {
    config.quota.costGuardEnabled = true;
    config.quota.costGuardMicroYuan.free = 1500;
    const { svc } = makeService({ tier: "free" });
    await svc.completeChatTurn("u1", undefined, { inputTokens: 0, outputTokens: 300 }, "z-ai/glm-5.3-flash");
    // 300 × 6.48 = 1944 microYuan ≥ 1500
    const gate = await svc.beginChatTurn("u1");
    expect(gate?.verdict).toBe("cost_guard");
  });

  it("cost guard takes precedence over the count cap (both exceeded → COST_GUARD)", async () => {
    config.quota.costGuardEnabled = true;
    config.quota.costGuardMicroYuan.free = 100;
    config.quota.limits.chat = { free: 1, vip: 1, svip: 1 };
    const { svc } = makeService({ tier: "free" });
    // 100 output tokens × 6.48 = 648 microYuan ≥ 100，且次数已到 1/1
    await svc.completeChatTurn("u1", undefined, { inputTokens: 0, outputTokens: 100 }, "z-ai/glm-5.3-flash");
    const gate = await svc.beginChatTurn("u1");
    expect(gate?.verdict).toBe("cost_guard");
  });

  it("does not block while the guard is disabled (pre-calibration default)", async () => {
    config.quota.costGuardEnabled = false;
    config.quota.costGuardMicroYuan.free = 1;
    const { svc } = makeService({ tier: "free" });
    await svc.completeChatTurn("u1", undefined, { inputTokens: 0, outputTokens: 9999 }, "z-ai/glm-5.3-flash");
    const gate = await svc.beginChatTurn("u1");
    expect(gate?.verdict).toBe("allow");
  });
});

describe("QuotaService failure semantics (P4)", () => {
  it("fails OPEN when the counter store is unavailable", async () => {
    const { svc } = makeService({ tier: "free", counter: brokenCounter() });
    const gate = await svc.beginChatTurn("u1");
    expect(gate?.verdict).toBe("allow");
    expect(gate?.storeUnavailable).toBe(true);
  });

  it("fails CLOSED to the free tier when membership resolution misbehaves", async () => {
    config.quota.limits.chat = { free: 1, vip: 100, svip: 300 };
    const counter = new MemoryQuotaCounter();
    const svc = new QuotaService({
      counter,
      // a misbehaving resolver returns garbage → normalized to free
      resolveTier: async () => "platinum",
    });
    await svc.completeChatTurn("u1", undefined, undefined, "z-ai/glm-5.3-flash");
    const gate = await svc.beginChatTurn("u1");
    expect(gate?.tier).toBe("free");
    expect(gate?.verdict).toBe("quota_exceeded"); // free limit=1 already consumed
  });
});

describe("QuotaService anonymous bucketing", () => {
  it("meters chat_anon by clientKey and rejects over budget", async () => {
    config.quota.limits.chat_anon = { free: 1, vip: 1, svip: 1 };
    const { svc } = makeService({ tier: "free" });
    const ip = hashClientKey("203.0.113.9");
    const g1 = await svc.beginChatTurn(undefined, ip);
    expect(g1?.kind).toBe("chat_anon");
    expect(g1?.verdict).toBe("allow");
    await svc.completeChatTurn(undefined, ip, undefined, "z-ai/glm-5.3-flash");
    const g2 = await svc.beginChatTurn(undefined, ip);
    expect(g2?.verdict).toBe("quota_exceeded");
  });

  it("skips gating entirely for unattributable requests (no uid, no IP)", async () => {
    const { svc } = makeService({ tier: "free" });
    expect(await svc.beginChatTurn(undefined, undefined)).toBeNull();
  });
});

describe("QuotaService image attachments", () => {
  it("check-then-add batches; rejects the batch that would overflow", async () => {
    config.quota.limits.chat_images = { free: 3, vip: 100, svip: 300 };
    const { svc } = makeService({ tier: "free" });
    expect(await svc.consumeImages("u1", undefined, 2)).toBe(true);
    expect(await svc.consumeImages("u1", undefined, 2)).toBe(false); // 2+2 > 3
    expect(await svc.consumeImages("u1", undefined, 1)).toBe(true);
    expect(await svc.consumeImages("u1", undefined, 1)).toBe(false);
  });
});

describe("QuotaService keys and boundaries", () => {
  // 2026-10-14T18:00Z = 2026-10-15 02:00 Shanghai = UTC day 20261014
  const now = new Date("2026-10-14T18:00:00Z");

  it("keeps generate/grade on app-quiz's legacy UTC-day counters", async () => {
    const { svc } = makeService({ now });
    expect(svc.keyFor("generate", "123", now)).toBe("mind-base:quiz_quota:generate:123:20261014");
    expect(svc.keyFor("grade", "123", now)).toBe("mind-base:quiz_quota:grade:123:20261014");
  });

  it("keys user-facing kinds on the Shanghai calendar day", async () => {
    const { svc } = makeService({ now });
    expect(svc.keyFor("chat", "123", now)).toBe("mind-base:quota:chat:123:20261015");
  });

  it("resetAt is the next Shanghai midnight", async () => {
    expect(nextMidnight(now)).toBe(Date.UTC(2026, 9, 15, 16, 0, 0));
  });

  it("accumulates cost as tokens × price (microYuan integer math)", async () => {
    const { svc, counter } = makeService({ tier: "vip", now });
    await svc.completeChatTurn("u1", undefined, { inputTokens: 7000, outputTokens: 2000 }, "z-ai/glm-5.3-flash");
    const chatCount = await counter.count(svc.keyFor("chat", "u1", now));
    const cost = await counter.count(svc.costKey("u1", now));
    expect(chatCount).toBe(1);
    expect(cost).toBe(14276); // 7000×0.188 + 2000×6.48 = 1316 + 12960
  });
});

describe("QuotaService peekKind/consumeKind (quiz tier-ization)", () => {
  it("enforces tier limits on the legacy UTC-day counter", async () => {
    config.quota.limits.generate = { free: 2, vip: 20, svip: 60 };
    const now = new Date("2026-10-14T18:00:00Z");
    const { svc, counter } = makeService({ tier: "free", now });

    const g1 = await svc.peekKind("u1", "generate");
    expect(g1?.verdict).toBe("allow");
    expect(g1?.limit).toBe(2);
    expect(await svc.consumeKind("u1", "generate")).toBe(true);
    expect(await svc.consumeKind("u1", "generate")).toBe(true);

    const over = await svc.peekKind("u1", "generate");
    expect(over?.verdict).toBe("quota_exceeded");
    expect(await svc.consumeKind("u1", "generate")).toBe(false);

    // legacy key = app-quiz format (UTC day) — both stacks share one counter
    expect(svc.keyFor("generate", "u1", now)).toBe("mind-base:quiz_quota:generate:u1:20261014");
    expect(await counter.count(svc.keyFor("generate", "u1", now))).toBe(2);
  });

  it("fails open when the store is unavailable", async () => {
    const { svc } = makeService({ tier: "vip", counter: brokenCounter() });
    expect(await svc.peekKind("u1", "generate")).toBeNull();
    expect(await svc.consumeKind("u1", "generate")).toBe(true);
  });

  it("stockLimit returns the tier ceiling for stock caps", async () => {
    config.quota.limits.task_quiz_active = { free: 2, vip: 10, svip: 30 };
    const vip = makeService({ tier: "vip" });
    expect(await vip.svc.stockLimit("u1", "task_quiz_active")).toBe(10);
    const free = makeService({ tier: "free" });
    expect(await free.svc.stockLimit("u1", "task_quiz_active")).toBe(2);
  });
});

describe("costMicroYuan", () => {
  it("is zero without a price entry (unknown model)", () => {
    expect(costMicroYuan(1000, 1000, undefined)).toBe(0);
  });
});
