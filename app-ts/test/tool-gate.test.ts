import { describe, it, expect, vi, afterEach } from "vitest";
import { Semaphore } from "../src/tools/concurrency.js";
import { AgentRuntime } from "../src/tools/runtime.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { defineTool } from "../src/tools/base.js";
import { ResultCollector } from "../src/context/types.js";
import { z } from "zod";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => resolve("done"), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("Aborted"));
    });
  });

function ctx() {
  return { uid: 1, chatSessionId: "s1", scope: {}, collector: new ResultCollector() };
}

const contentOf = (out: { content: string }) => out.content;

describe("Semaphore", () => {
  it("grants up to max, queues beyond, releases correctly", async () => {
    const sem = new Semaphore(2, "test");
    const r1 = await sem.acquire(100);
    const r2 = await sem.acquire(100);
    expect(r1).toBeTruthy();
    expect(r2).toBeTruthy();
    expect(sem.running).toBe(2);

    const waitP = sem.acquire(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(sem.waiting).toBe(1);
    r1!();
    const r3 = await waitP; // freed slot handed to the waiter
    expect(r3).toBeTruthy();
    expect(sem.running).toBe(2);

    r2!();
    r3!();
    expect(sem.running).toBe(0);
  });

  it("wait budget expiry resolves null (fail fast)", async () => {
    const sem = new Semaphore(1, "test");
    const r1 = await sem.acquire(10_000);
    const r2 = await sem.acquire(30);
    expect(r2).toBeNull(); // gave up
    r1!();
    const r3 = await sem.acquire(10_000);
    expect(r3).toBeTruthy();
    r3!();
  });
});

// ---------- runtime integration ----------

const slowTool = defineTool({
  name: "slow",
  description: "slow",
  inputSchema: z.object({ ms: z.number() }),
  execute: async (args, _ctx, signal) => sleep(args.ms, signal),
});
const flakyTool = defineTool({
  name: "flaky",
  description: "always fails",
  inputSchema: z.object({}),
  execute: async () => {
    throw new Error("下游挂了");
  },
});
const instantTool = defineTool({
  name: "instant",
  description: "instant",
  inputSchema: z.object({}),
  execute: async () => "ok",
});

function registryWith(...tools: ReturnType<typeof defineTool>[]) {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}

describe("concurrency gate (global, across turns)", () => {
  it("9th concurrent call fails fast with busy text when max=8 slots are held", async () => {
    const rt = new AgentRuntime(registryWith(slowTool), { maxConcurrent: 8, queueWaitMs: 50 });
    const collectors = Array.from({ length: 8 }, () => ctx());
    // hold all 8 slots with slow executions (200ms)
    const holding = collectors.map((c) =>
      rt.execute({ name: "slow", execute: slowTool.execute }, { ms: 200 }, c),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(rt.gateStats().running).toBe(8);

    // a 9th turn's call cannot get a slot within 50ms → busy, NOT counted as tool failure
    const busy = await rt.execute({ name: "slow", execute: slowTool.execute }, { ms: 10 }, ctx());
    expect(contentOf(busy)).toContain("系统繁忙");
    expect(rt.monitor().slow.busy).toBe(1);
    expect(rt.monitor().slow.errors).toBe(0);

    await Promise.all(holding);
    expect(rt.gateStats().running).toBe(0);
    // after release, calls go through again
    const ok = await rt.execute({ name: "slow", execute: slowTool.execute }, { ms: 5 }, ctx());
    expect(contentOf(ok)).toBe("done");
  });

  it("slots are released even when the tool times out", async () => {
    const rt = new AgentRuntime(registryWith(slowTool), { maxConcurrent: 1, queueWaitMs: 10 });
    const out = await rt.execute(
      { name: "slow", execute: slowTool.execute },
      { ms: 5_000, timeoutMs: 1_000 },
      ctx(),
    );
    expect(contentOf(out)).toContain("执行超时");
    // slot freed by the timeout path → next call proceeds immediately
    const ok = await rt.execute({ name: "slow", execute: slowTool.execute }, { ms: 5 }, ctx());
    expect(contentOf(ok)).toBe("done");
    expect(rt.gateStats().running).toBe(0);
  });
});

describe("tool-level breaker", () => {
  it("opens after threshold consecutive failures and short-circuits without executing", async () => {
    const r = registryWith(flakyTool);
    let execCount = 0;
    const counting = defineTool({
      name: "flaky",
      description: "always fails",
      inputSchema: z.object({}),
      execute: async () => {
        execCount += 1;
        throw new Error("下游挂了");
      },
    });
    const r2 = new ToolRegistry();
    r2.register(counting);
    const rt = new AgentRuntime(() => r2.list(), { breakerThreshold: 2, breakerCooldownMs: 200 });

    for (let i = 0; i < 2; i++) {
      const out = await rt.execute({ name: "flaky", execute: counting.execute }, {}, ctx());
      expect(contentOf(out)).toContain("工具执行失败");
    }
    expect(rt.breakerStates().flaky.state).toBe("open");

    const shortCircuit = await rt.execute({ name: "flaky", execute: counting.execute }, {}, ctx());
    expect(contentOf(shortCircuit)).toContain("熔断");
    expect(execCount).toBe(2); // the short-circuited call never executed
    expect(rt.monitor().flaky.shortCircuited).toBe(1);
  });

  it("cooldown passes → half-open probe; success closes the breaker", async () => {
    vi.useFakeTimers();
    let fail = true;
    const toggle = defineTool({
      name: "toggle",
      description: "t",
      inputSchema: z.object({}),
      execute: async () => {
        if (fail) throw new Error("坏");
        return { content: "ok" };
      },
    });
    const r = new ToolRegistry();
    r.register(toggle);
    const rt = new AgentRuntime(() => r.list(), { breakerThreshold: 1, breakerCooldownMs: 200 });

    await rt.execute({ name: "toggle", execute: toggle.execute }, {}, ctx());
    expect(rt.breakerStates().toggle.state).toBe("open");

    vi.advanceTimersByTime(250);
    fail = false; // half-open probe succeeds → breaker closes
    const out = await rt.execute({ name: "toggle", execute: toggle.execute }, {}, ctx());
    expect(contentOf(out)).toBe("ok");
    expect(rt.breakerStates().toggle.state).toBe("closed");
    vi.useRealTimers();
  });

  it("timeouts feed the breaker too", async () => {
    const rt = new AgentRuntime(registryWith(slowTool), {
      breakerThreshold: 2,
      breakerCooldownMs: 10_000,
      queueWaitMs: 10,
    });
    const c = ctx();
    for (let i = 0; i < 2; i++) {
      await rt.execute({ name: "slow", execute: slowTool.execute }, { ms: 5_000, timeoutMs: 1_000 }, c);
    }
    expect(rt.monitor().slow.timeouts).toBe(2);
    expect(rt.breakerStates().slow.state).toBe("open");
    // next call is rejected instantly (no 1s grind)
    const out = await rt.execute({ name: "slow", execute: slowTool.execute }, { ms: 5_000, timeoutMs: 1_000 }, c);
    expect(contentOf(out)).toContain("熔断");
  });

  it("instant tools are unaffected by gate/breaker (happy path)", async () => {
    const rt = new AgentRuntime(registryWith(instantTool));
    const out = await rt.execute({ name: "instant", execute: instantTool.execute }, {}, ctx());
    expect(contentOf(out)).toBe("ok");
    expect(rt.breakerStates().instant.state).toBe("closed");
    expect(rt.gateStats().running).toBe(0);
  });
});
