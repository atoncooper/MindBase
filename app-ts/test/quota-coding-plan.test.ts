import { describe, it, expect, afterEach, beforeEach } from "vitest";
import type { LanguageModel } from "ai";
import { QuotaService, hashClientKey, rawTokensFor } from "../src/services/quota.js";
import { ChatService } from "../src/services/chat.js";
import type { QuotaCounterStore } from "../src/repository/quota.js";
import { MemoryQuotaCounter } from "../src/repository/memory/quota-counter.js";
import { MemoryUsageLedger } from "../src/repository/memory/usage-ledger.js";
import {
  MemoryChatSessionRepository,
  MemoryMessageRepository,
} from "../src/repository/memory/chat-store.js";
import type { AgentHarness } from "../src/harness/app.js";
import type { SseFrame } from "../src/transport/sse.js";
import { config } from "../src/config/index.js";

/**
 * Coding Plan（external，用户自付套餐）token 计量：
 *  - provider 实际 token 写入独立 external 计数（5h / 日 / 月 + 今日按模型 + 轮次），
 *    绝不移动平台额度窗口 / 成本 / kind 明细；
 *  - /quota/summary 始终带 codingPlan 段（quota.enabled=false 时也统计）；
 *  - provider 缺 usage 时与平台轮次共用同一套估算兜底；
 *  - 0 / 非法 usage 与不可归属请求是 no-op。
 */

const savedQuota = structuredClone(config.quota);
// 2026-11 出货默认 quota.enabled=false；这里显式开启以覆盖门禁相关的分支。
beforeEach(() => {
  config.quota.enabled = true;
});
afterEach(() => {
  config.quota = structuredClone(savedQuota);
});

/** Counter whose every read/write reports unavailable — the fail-open probe. */
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

function makeService(opts: { tier?: string; now?: Date | (() => Date); counter?: QuotaCounterStore } = {}) {
  const counter = opts.counter ?? new MemoryQuotaCounter();
  const nowFn =
    typeof opts.now === "function" ? opts.now : opts.now ? () => opts.now as Date : undefined;
  const svc = new QuotaService({
    counter,
    resolveTier: async () => opts.tier ?? "vip",
    now: nowFn,
  });
  return { svc, counter };
}

describe("rawTokensFor", () => {
  it("sums input + output, tolerates total-only reports, rejects invalid values", () => {
    expect(rawTokensFor(undefined)).toBe(0);
    expect(rawTokensFor({})).toBe(0);
    expect(rawTokensFor({ inputTokens: 120, outputTokens: 30 })).toBe(150);
    expect(rawTokensFor({ totalTokens: 200 })).toBe(200);
    expect(rawTokensFor({ inputTokens: 100, totalTokens: 250 })).toBe(250);
    expect(rawTokensFor({ inputTokens: Number.NaN, outputTokens: -5, totalTokens: Number.POSITIVE_INFINITY })).toBe(0);
    // 非整数按 floor（provider usage 是整数；脏值不能放大计量）
    expect(rawTokensFor({ inputTokens: 12.9, outputTokens: 3.2 })).toBe(15);
  });
});

describe("QuotaService.recordExternalTurn", () => {
  it("counts coding-plan tokens without moving platform windows, kinds or cost", async () => {
    const now = new Date("2026-11-20T04:00:00Z");
    const { svc } = makeService({ tier: "vip", now });

    const tokens = await svc.recordExternalTurn(
      "u1",
      undefined,
      { inputTokens: 5000, outputTokens: 2000 },
      "opencode/zen-pro",
    );
    expect(tokens).toBe(7000);

    const summary = await svc.summary("u1");
    expect(summary.windows.every((w) => w.used === 0)).toBe(true);
    expect(summary.kinds.every((k) => k.used === 0)).toBe(true);
    expect(summary.cost.microYuan).toBe(0);
    expect(summary.codingPlan).toMatchObject({
      fiveHourTokens: 7000,
      dayTokens: 7000,
      monthTokens: 7000,
      turns: 1,
    });
    expect(summary.codingPlan.byModel).toEqual([{ model: "opencode/zen-pro", tokens: 7000 }]);
  });

  it("rolls the external 5h window while keeping day/month totals and turn count", async () => {
    let clock = new Date("2026-11-20T02:00:00Z");
    const { svc } = makeService({ tier: "vip", now: () => clock });
    await svc.recordExternalTurn("u1", undefined, { inputTokens: 1000 }, "opencode/zen-pro");
    clock = new Date("2026-11-20T08:01:00Z"); // 6h1m later: the first turn rolled out of 5h
    await svc.recordExternalTurn("u1", undefined, { inputTokens: 500 }, "opencode/zen-pro");

    const summary = await svc.summary("u1");
    expect(summary.codingPlan.fiveHourTokens).toBe(500);
    expect(summary.codingPlan.dayTokens).toBe(1500);
    expect(summary.codingPlan.monthTokens).toBe(1500);
    expect(summary.codingPlan.turns).toBe(2);
  });

  it("keeps a per-model breakdown sorted by today's tokens", async () => {
    const { svc } = makeService({ tier: "vip" });
    await svc.recordExternalTurn("u1", undefined, { inputTokens: 300 }, "opencode/zen-a");
    await svc.recordExternalTurn("u1", undefined, { inputTokens: 900 }, "opencode/zen-b");

    const summary = await svc.summary("u1");
    expect(summary.codingPlan.byModel).toEqual([
      { model: "opencode/zen-b", tokens: 900 },
      { model: "opencode/zen-a", tokens: 300 },
    ]);
  });

  it("is a no-op for zero/invalid usage and unattributable identities", async () => {
    const { svc } = makeService({ tier: "vip" });
    expect(await svc.recordExternalTurn("u1", undefined, undefined, "m")).toBe(0);
    expect(
      await svc.recordExternalTurn("u1", undefined, { inputTokens: Number.NaN, outputTokens: -1 }, "m"),
    ).toBe(0);
    expect(await svc.recordExternalTurn(undefined, undefined, { inputTokens: 10 }, "m")).toBe(0);

    const summary = await svc.summary("u1");
    expect(summary.codingPlan).toMatchObject({
      fiveHourTokens: 0,
      dayTokens: 0,
      monthTokens: 0,
      turns: 0,
    });
    expect(summary.codingPlan.byModel).toBeUndefined();
  });

  it("still records and reports when the platform quota gate is disabled", async () => {
    config.quota.enabled = false;
    const { svc } = makeService({ tier: "vip" });
    await svc.recordExternalTurn("u1", undefined, { inputTokens: 800, outputTokens: 200 }, "opencode/zen-pro");

    const summary = await svc.summary("u1");
    expect(summary.enabled).toBe(false);
    expect(summary.windows.every((w) => w.used === 0)).toBe(true);
    expect(summary.codingPlan.dayTokens).toBe(1000);
    expect(summary.codingPlan.turns).toBe(1);
  });

  it("reports zero coding-plan usage for the anonymous IP bucket", async () => {
    const { svc } = makeService({ tier: "free" });
    const summary = await svc.summary(undefined, hashClientKey("203.0.113.9"));
    expect(summary.codingPlan).toMatchObject({
      fiveHourTokens: 0,
      dayTokens: 0,
      monthTokens: 0,
      turns: 0,
    });
  });

  it("fails open (0, no throw) when the counter store is unavailable", async () => {
    const { svc } = makeService({ tier: "vip", counter: brokenCounter() });
    expect(await svc.recordExternalTurn("u1", undefined, { inputTokens: 10 }, "m")).toBe(10);
    const summary = await svc.summary("u1");
    expect(summary.codingPlan).toMatchObject({ dayTokens: 0, monthTokens: 0, turns: 0 });
  });
});

/* ── ChatService × Coding Plan（估算兜底 + 账本 + 失败不计量） ───────── */

async function drain(gen: AsyncGenerator<SseFrame>, guardMs = 4000): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  const deadline = Date.now() + guardMs;
  while (Date.now() < deadline) {
    const r = await gen.next();
    if (r.done) break;
    frames.push(r.value);
  }
  return frames;
}

/** Harness that streams an answer but never reports provider usage. */
function passthroughHarness(): AgentHarness {
  return {
    dispatchStream: async function* (): AsyncGenerator<SseFrame> {
      yield { type: "route", agent: "main" };
      yield { type: "chunk", content: "ok" };
      yield { type: "done" };
    },
  } as unknown as AgentHarness;
}

function errorHarness(): AgentHarness {
  return {
    dispatchStream: async function* (): AsyncGenerator<SseFrame> {
      yield { type: "route", agent: "main" };
      yield { type: "error", message: "boom" };
      yield { type: "done" };
    },
  } as unknown as AgentHarness;
}

type ResolveModel = (input: {
  uid?: string;
  model?: string;
  sessionId?: string;
}) => Promise<{ model: LanguageModel; modelId: string } | undefined>;

function codingPlanResolver(modelId: string): ResolveModel {
  return async () => ({ model: {} as LanguageModel, modelId });
}

function makeChat(opts: {
  quota: QuotaService;
  ledger?: MemoryUsageLedger;
  harness?: AgentHarness;
  resolveModel?: ResolveModel;
}) {
  const chat = new ChatService(
    opts.harness ?? passthroughHarness(),
    new MemoryChatSessionRepository(),
    new MemoryMessageRepository(),
    undefined,
    undefined,
    null,
    undefined,
    opts.quota,
    opts.ledger ?? null,
    undefined,
    undefined,
    opts.resolveModel,
  );
  return { chat };
}

describe("ChatService × Coding Plan token accounting", () => {
  it("estimates missing usage like platform turns and records it as external", async () => {
    const quota = makeService({ tier: "vip" }).svc;
    const ledger = new MemoryUsageLedger();
    const { chat } = makeChat({ quota, ledger, resolveModel: codingPlanResolver("opencode/zen-pro") });

    const frames = await drain(chat.askStream({ query: "你好", sessionId: "cp1", uid: "u1" }));
    expect(frames.some((f) => f.type === "error")).toBe(false);

    const summary = await quota.summary("u1");
    expect(summary.codingPlan.dayTokens).toBeGreaterThan(0);
    expect(summary.codingPlan.turns).toBe(1);
    expect(summary.windows.find((w) => w.window === "day")?.used).toBe(0);
    expect(summary.cost.microYuan).toBe(0);

    const rows = ledger.snapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      uid: "u1",
      purpose: "chat_coding_plan",
      model: "opencode/zen-pro",
      costMicroYuan: 0,
    });
    expect(rows[0]?.inputTokens).toBeGreaterThan(0);
    expect(rows[0]?.outputTokens).toBeGreaterThan(0);
  });

  it("never records external tokens for a failed turn (consume-on-success)", async () => {
    const quota = makeService({ tier: "vip" }).svc;
    const { chat } = makeChat({
      quota,
      harness: errorHarness(),
      resolveModel: codingPlanResolver("opencode/zen-pro"),
    });

    await drain(chat.askStream({ query: "x", sessionId: "cp2", uid: "u1" }));
    const summary = await quota.summary("u1");
    expect(summary.codingPlan.turns).toBe(0);
    expect(summary.codingPlan.dayTokens).toBe(0);
  });

  it("keeps platform turns on the platform windows (no coding-plan leak)", async () => {
    const quota = makeService({ tier: "vip" }).svc;
    const ledger = new MemoryUsageLedger();
    const { chat } = makeChat({ quota, ledger }); // no resolver → platform gateway model

    await drain(chat.askStream({ query: "hi", sessionId: "cp3", uid: "u1" }));
    const summary = await quota.summary("u1");
    expect(summary.windows.find((w) => w.window === "day")?.used).toBeGreaterThan(0);
    expect(summary.codingPlan.turns).toBe(0);
    expect(summary.codingPlan.dayTokens).toBe(0);
    expect(ledger.snapshot()[0]).toMatchObject({ purpose: "chat" });
  });
});
