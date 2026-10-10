import { describe, it, expect } from "vitest";
import { TimeoutManager, timeoutManager } from "../src/tools/timeout-manager.js";
import { AgentRuntime } from "../src/tools/runtime.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { defineTool } from "../src/tools/base.js";
import { ResultCollector } from "../src/context/types.js";
import { z, ZodObject } from "zod";

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

describe("TimeoutManager", () => {
  it("resolveBudget clamps: default / floor / 1h ceiling", () => {
    const m = new TimeoutManager();
    expect(m.resolveBudget(undefined)).toBe(60_000); // default
    expect(m.resolveBudget(500)).toBe(1_000); // floor
    expect(m.resolveBudget(10_000_000)).toBe(3_600_000); // 1h ceiling
    expect(m.resolveBudget(1_800_000)).toBe(1_800_000); // 30min honored
    expect(m.resolveBudget(Number.NaN)).toBe(60_000);
  });

  it("success resolves with value and removes the active entry", async () => {
    const m = new TimeoutManager();
    const out = await m.run("tool", 5_000, async () => 42);
    expect(out).toMatchObject({ ok: true, value: 42, budgetMs: 5_000 });
    expect(m.size).toBe(0);
  });

  it("timeout aborts the signal, reports timedOut and deletes the entry", async () => {
    vi_setTimeout();
    const m = new TimeoutManager();
    let observedAbort = false;
    const out = await m.run("slow-tool", 1_000, async (signal) => {
      await sleep(10_000, signal);
      observedAbort = true;
      return "never";
    });
    expect(out).toMatchObject({ ok: false, timedOut: true, budgetMs: 1_000 });
    expect(observedAbort).toBe(false); // aborted before completion
    expect(m.size).toBe(0); // deleted from the active table
    vi_restore();
  });

  it("list() reports remaining time while running", async () => {
    const m = new TimeoutManager();
    const pending = m.run("job", 5_000, (signal) => sleep(50, signal));
    await new Promise((r) => setTimeout(r, 10));
    const tickets = m.list();
    expect(tickets).toHaveLength(1);
    expect(tickets[0].label).toBe("job");
    expect(tickets[0].remainingMs).toBeGreaterThan(0);
    await pending;
    expect(m.size).toBe(0);
  });

  it("genuine tool errors are rethrown (not masked as timeouts)", async () => {
    const m = new TimeoutManager();
    await expect(m.run("boom", 5_000, async () => {
      throw new Error("真实错误");
    })).rejects.toThrow("真实错误");
  });
});

function vi_setTimeout() { /* real timers used; keep helper names meaningful */ }
function vi_restore() { /* no-op */ }

describe("runtime integration", () => {
  const slowTool = defineTool({
    name: "slow",
    description: "slow tool",
    inputSchema: z.object({ ms: z.number() }),
    execute: async (args, _ctx, signal) => sleep(args.ms, signal),
  });
  const instantTool = defineTool({
    name: "instant",
    description: "instant",
    inputSchema: z.object({}),
    execute: async () => "ok",
  });

  function makeRuntime() {
    const r = new ToolRegistry();
    r.register(slowTool);
    r.register(instantTool);
    return new AgentRuntime(() => r.list());
  }

  it("model-passed timeoutMs aborts an overrunning tool with guidance text", async () => {
    const runtime = makeRuntime();
    const out = await runtime.execute(
      { name: "slow", execute: slowTool.execute },
      { ms: 5_000, timeoutMs: 1_000 },
      ctx(),
    );
    expect(out.content).toContain("执行超时（1s）");
    expect(out.content).toContain("timeoutMs");
    expect(runtime.monitor().slow.timeouts).toBe(1);
    // active table drained
    expect(timeoutManager.size).toBe(0);
  });

  it("fast calls succeed and timeoutMs is stripped from tool args", async () => {
    const runtime = makeRuntime();
    const seen: unknown[] = [];
    const spy = defineTool({
      name: "spy",
      description: "spy",
      inputSchema: z.object({ q: z.string() }),
      execute: async (args) => {
        seen.push(args);
        return "ok";
      },
    });
    const r2 = new ToolRegistry();
    r2.register(spy);
    const rt = new AgentRuntime(() => r2.list());
    const out = await rt.execute({ name: "spy", execute: spy.execute }, { q: "x", timeoutMs: 5_000 }, ctx());
    expect(out.content).toBe("ok");
    expect(seen[0]).toEqual({ q: "x" }); // no timeoutMs leaked into the tool
  });

  it("timeoutMs does not bypass the repeat-call ledger", async () => {
    const r2 = new ToolRegistry();
    r2.register(instantTool);
    const rt = new AgentRuntime(() => r2.list());
    const c = ctx();
    const def = { name: "instant", execute: instantTool.execute };
    for (let i = 0; i < 3; i++) {
      const out = await rt.execute(def, { timeoutMs: 1_000 + i }, c); // different budgets each time
      expect(out.content).toBe("ok");
    }
    const rejected = await rt.execute(def, { timeoutMs: 9_999 }, c);
    expect(rejected.content).toContain("已调用 3 次");
  });
});

describe("schema injection", () => {
  it("object-shaped schemas gain the shared timeoutMs field", () => {
    const schema = z.object({ query: z.string() });
    const extended = (schema as ZodObject<z.ZodRawShape>).extend({
      timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
    });
    const parsed = extended.safeParse({ query: "q", timeoutMs: 30_000 });
    expect(parsed.success).toBe(true);
    const rejected = extended.safeParse({ query: "q", timeoutMs: 7_200_000 }); // > 1h
    expect(rejected.success).toBe(false);
  });
});
