import { describe, it, expect } from "vitest";
import { simulateReadableStream, type LanguageModelV2StreamPart } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import {
  PlanStore,
  createPlanTool,
  renderPlan,
  PLAN_MAX_STEPS,
  PLAN_REVISE_LIMIT,
} from "../src/tools/harness/plan.js";
import { ResultCollector, type PlanSnapshot } from "../src/context/types.js";
import { encodeFrame, type SseFrame } from "../src/transport/sse.js";
import { createReactAgent } from "../src/agent/react.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { AgentRuntime } from "../src/tools/runtime.js";

/**
 * plan tool: per-chat-session state machine (create/update/revise) + rendered
 * feedback text + collector snapshot. Plus the live `plan` SSE frame: emitted at
 * each step boundary where the plan version changed (see agent/react.ts), never
 * duplicated at the stream tail.
 */

const STEPS = ["检索收藏视频", "整理要点", "输出答案"];

function ctx(chatSessionId = "s1") {
  return { uid: "1", chatSessionId, scope: {}, collector: new ResultCollector() };
}

const contentOf = (out: unknown): string =>
  typeof out === "string" ? out : (out as { content: string }).content;

const errorOf = (result: { ok: boolean; error?: string }) => (result.ok ? "" : (result.error ?? ""));

describe("PlanStore create", () => {
  it("creates a pending plan at version 1", () => {
    const store = new PlanStore();
    const result = store.apply("s1", { action: "create", steps: STEPS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.version).toBe(1);
    expect(result.snapshot.total).toBe(3);
    expect(result.snapshot.done).toBe(0);
    expect(result.snapshot.steps.map((s) => s.status)).toEqual(["pending", "pending", "pending"]);
    expect(store.get("s1")).toEqual(result.snapshot);
  });

  it("trims descriptions, drops blanks and truncates beyond the 6-step cap", () => {
    const store = new PlanStore();
    const result = store.apply("s1", {
      action: "create",
      steps: ["  第一步  ", "", "第二步", "三", "四", "五", "六", "七"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.total).toBe(PLAN_MAX_STEPS);
    expect(result.snapshot.steps[0]?.desc).toBe("第一步");
    expect(result.snapshot.steps.map((s) => s.desc)).not.toContain("七");
    expect(result.snapshot.steps.map((s) => s.desc)).not.toContain("");
  });

  it("accepts a single-step plan but rejects an empty one", () => {
    const store = new PlanStore();
    expect(store.apply("small", { action: "create", steps: ["一步搞定"] }).ok).toBe(true);
    const empty = store.apply("empty", { action: "create", steps: [" ", ""] });
    expect(empty.ok).toBe(false);
    expect(errorOf(empty)).toContain("steps 不能为空");
    expect(store.get("empty")).toBeUndefined();
  });

  it("re-creating a session plan bumps the version (new request in a long chat)", () => {
    const store = new PlanStore();
    store.apply("s1", { action: "create", steps: STEPS });
    const again = store.apply("s1", { action: "create", steps: ["新任务一", "新任务二", "新任务三"] });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.snapshot.version).toBe(2);
    expect(again.snapshot.steps.map((s) => s.desc)).toEqual(["新任务一", "新任务二", "新任务三"]);
  });
});

describe("PlanStore update", () => {
  it("updates step status/note, bumps the version and counts done + skipped", () => {
    const store = new PlanStore();
    store.apply("s1", { action: "create", steps: STEPS });

    const done = store.apply("s1", { action: "update", step: 1, status: "done", note: "找到 5 条" });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.snapshot.version).toBe(2);
    expect(done.snapshot.done).toBe(1);
    expect(done.snapshot.steps[0]).toEqual({ desc: STEPS[0], status: "done", note: "找到 5 条" });

    const skipped = store.apply("s1", { action: "update", step: 2, status: "skipped" });
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;
    expect(skipped.snapshot.version).toBe(3);
    expect(skipped.snapshot.done).toBe(2);
  });

  it("defaults status to done and clears the note when omitted", () => {
    const store = new PlanStore();
    store.apply("s1", { action: "create", steps: STEPS });
    store.apply("s1", { action: "update", step: 1, status: "in_progress", note: "进行中" });
    const result = store.apply("s1", { action: "update", step: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.steps[0]).toEqual({ desc: STEPS[0], status: "done", note: "" });
  });

  it("rejects out-of-range step numbers (state unchanged)", () => {
    const store = new PlanStore();
    store.apply("s1", { action: "create", steps: STEPS });
    for (const step of [0, 4, 99]) {
      const result = store.apply("s1", { action: "update", step, status: "done" });
      expect(result.ok).toBe(false);
      expect(errorOf(result)).toContain("步骤编号无效");
    }
    expect(store.get("s1")?.version).toBe(1);
  });

  it("rejects updates before a plan exists and unknown statuses", () => {
    const store = new PlanStore();
    expect(errorOf(store.apply("s1", { action: "update", step: 1, status: "done" }))).toContain(
      "尚未创建计划",
    );
    store.apply("s1", { action: "create", steps: STEPS });
    const bad = store.apply("s1", {
      action: "update",
      step: 1,
      status: "bogus" as never,
    });
    expect(bad.ok).toBe(false);
    expect(errorOf(bad)).toContain("未知状态");
    expect(store.get("s1")?.version).toBe(1);
  });
});

describe("PlanStore revise", () => {
  it("requires a reason and leaves the plan untouched without one", () => {
    const store = new PlanStore();
    store.apply("s1", { action: "create", steps: STEPS });
    const result = store.apply("s1", { action: "revise", steps: ["改一", "改二", "改三"] });
    expect(result.ok).toBe(false);
    expect(errorOf(result)).toContain("reason");
    expect(store.get("s1")?.version).toBe(1);
    expect(store.get("s1")?.steps.map((s) => s.desc)).toEqual(STEPS);
  });

  it("replaces the remaining steps, bumps the version and counts revisions", () => {
    const store = new PlanStore();
    store.apply("s1", { action: "create", steps: STEPS });
    for (let i = 1; i <= PLAN_REVISE_LIMIT; i += 1) {
      const result = store.apply("s1", {
        action: "revise",
        steps: ["剩余 A" + i, "剩余 B" + i, "剩余 C" + i],
        reason: "第 2 步检索失败，改走网页搜索",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.snapshot.version).toBe(1 + i);
      expect(result.snapshot.total).toBe(3);
      expect(result.snapshot.steps[0]?.desc).toBe("剩余 A" + i);
    }
  });

  it("refuses a fourth revision and empty step lists", () => {
    const store = new PlanStore();
    store.apply("s1", { action: "create", steps: STEPS });
    const empty = store.apply("s1", { action: "revise", steps: [], reason: "空的" });
    expect(empty.ok).toBe(false);
    expect(errorOf(empty)).toContain("steps 不能为空");
    for (let i = 0; i < PLAN_REVISE_LIMIT; i += 1) {
      expect(store.apply("s1", { action: "revise", steps: ["x", "y", "z"], reason: "调整" }).ok).toBe(true);
    }
    const over = store.apply("s1", { action: "revise", steps: ["x", "y", "z"], reason: "再一次" });
    expect(over.ok).toBe(false);
    expect(errorOf(over)).toContain("上限");
  });
});

describe("PlanStore lifecycle (TTL + session cap)", () => {
  it("expires a plan after the TTL and refuses stale updates", () => {
    let now = 1_000;
    const store = new PlanStore({ ttlMs: 500, now: () => now });
    store.apply("s1", { action: "create", steps: STEPS });
    now += 400;
    expect(store.get("s1")).toBeDefined();
    now += 100; // idle time reached the TTL
    expect(store.get("s1")).toBeUndefined();
    expect(store.size).toBe(0);
    expect(store.apply("s1", { action: "update", step: 1, status: "done" }).ok).toBe(false);
  });

  it("purge reports how many expired plans it dropped", () => {
    let now = 0;
    const store = new PlanStore({ ttlMs: 100, now: () => now });
    store.apply("a", { action: "create", steps: STEPS });
    store.apply("b", { action: "create", steps: STEPS });
    now = 10;
    store.apply("c", { action: "create", steps: STEPS });
    now = 150;
    expect(store.purge()).toBe(3);
    expect(store.size).toBe(0);
    expect(store.purge()).toBe(0);
  });

  it("evicts the oldest session when the cap is reached", () => {
    let tick = 0;
    const store = new PlanStore({ maxSessions: 2, now: () => (tick += 1) });
    store.apply("s1", { action: "create", steps: STEPS });
    store.apply("s2", { action: "create", steps: STEPS });
    store.apply("s3", { action: "create", steps: STEPS });
    expect(store.size).toBe(2);
    expect(store.get("s1")).toBeUndefined();
    expect(store.get("s2")).toBeDefined();
    expect(store.get("s3")).toBeDefined();
  });
});

describe("renderPlan", () => {
  it("renders marks, numbering, notes and the done counter", () => {
    const snapshot: PlanSnapshot = {
      version: 7,
      done: 2,
      total: 5,
      steps: [
        { desc: "检索收藏视频", status: "done", note: "找到 3 条" },
        { desc: "整理要点", status: "skipped", note: "" },
        { desc: "输出答案", status: "in_progress", note: "" },
        { desc: "补充引用", status: "failed", note: "来源缺失" },
        { desc: "复查", status: "pending", note: "" },
      ],
    };
    const text = renderPlan(snapshot);
    expect(text).toContain("【任务计划 v7 · 第 2/5 步完成】");
    expect(text).toContain("✓ 1. 检索收藏视频 —— 找到 3 条");
    expect(text).toContain("⊘ 2. 整理要点");
    expect(text).toContain("▶ 3. 输出答案");
    expect(text).toContain("✗ 4. 补充引用 —— 来源缺失");
    expect(text).toContain("· 5. 复查");
    expect(text.split("\n")).toHaveLength(6);
  });
});

describe("plan tool", () => {
  it("create returns rendered text and registers the collector snapshot", async () => {
    const planTool = createPlanTool(new PlanStore());
    const c = ctx("chat-1");
    const out = await planTool.execute({ action: "create", steps: STEPS }, c);
    const text = contentOf(out);
    expect(text).toContain("【任务计划 v1 · 第 0/3 步完成】");
    expect(text).toContain("· 1. " + STEPS[0]);
    expect(c.collector.plan).toMatchObject({ version: 1, total: 3, done: 0 });
  });

  it("update mutates the same session plan and refreshes the snapshot", async () => {
    const store = new PlanStore();
    const planTool = createPlanTool(store);
    const c = ctx("chat-2");
    await planTool.execute({ action: "create", steps: STEPS }, c);
    const out = await planTool.execute(
      { action: "update", step: 2, status: "done", note: "要点已整理" },
      c,
    );
    const text = contentOf(out);
    expect(text).toContain("【任务计划 v2 · 第 1/3 步完成】");
    expect(text).toContain("✓ 2. " + STEPS[1] + " —— 要点已整理");
    expect(c.collector.plan).toMatchObject({ version: 2, done: 1, total: 3 });
    // the store is keyed by chatSessionId: another session has no plan
    const other = ctx("chat-3");
    await planTool.execute({ action: "update", step: 1, status: "done" }, other);
    expect(other.collector.plan).toBeUndefined();
  });

  it("invalid calls return guidance text without touching the snapshot", async () => {
    const planTool = createPlanTool(new PlanStore());
    const c = ctx();
    const missing = await planTool.execute({ action: "update", step: 1, status: "done" }, c);
    expect(contentOf(missing)).toContain("尚未创建计划");
    expect(c.collector.plan).toBeUndefined();

    await planTool.execute({ action: "create", steps: STEPS }, c);
    const previous = c.collector.plan;
    const outOfRange = await planTool.execute({ action: "update", step: 9, status: "done" }, c);
    expect(contentOf(outOfRange)).toContain("步骤编号无效");
    expect(c.collector.plan).toBe(previous);

    const badAction = await planTool.execute({ action: "nope" } as never, c);
    expect(contentOf(badAction)).toContain("未知 action");
  });

  it("falls back to a shared anonymous session when chatSessionId is missing", async () => {
    const planTool = createPlanTool(new PlanStore());
    const c = { scope: {}, collector: new ResultCollector() };
    const out = await planTool.execute({ action: "create", steps: STEPS }, c as never);
    expect(contentOf(out)).toContain("任务计划 v1");
    expect(c.collector.plan?.total).toBe(3);
  });
});

describe("plan SSE frame", () => {
  it("encodes the snapshot verbatim for the frontend", () => {
    const wire = encodeFrame({
      type: "plan",
      plan: {
        version: 2,
        done: 1,
        total: 2,
        steps: [
          { desc: "第一步", status: "done", note: "" },
          { desc: "第二步", status: "in_progress", note: "进行中" },
        ],
      },
    });
    const parsed = JSON.parse(wire.replace(/^data: /, ""));
    expect(parsed.type).toBe("plan");
    expect(parsed.plan.version).toBe(2);
    expect(parsed.plan.steps[1].status).toBe("in_progress");
  });

  it("is emitted live after each mutating step, before the answer text and exactly once per version", async () => {
    const frames = await collectPlanFrames();
    const plans = frames.filter((f): f is Extract<SseFrame, { type: "plan" }> => f.type === "plan");
    expect(plans.map((p) => p.plan.version)).toEqual([1, 2]);
    expect(plans[0]?.plan).toMatchObject({ version: 1, total: 3, done: 0 });
    expect(plans[1]?.plan).toMatchObject({ version: 2, done: 1 });

    const firstStepDone = frames.findIndex((f) => f.type === "step" && f.step.status === "done");
    const firstPlan = frames.indexOf(plans[0]!);
    const secondPlan = frames.indexOf(plans[1]!);
    const chunk = frames.findIndex((f) => f.type === "chunk" && f.content === "计划执行完成");
    expect(firstStepDone).toBeGreaterThanOrEqual(0);
    expect(firstPlan).toBeGreaterThan(firstStepDone);
    expect(secondPlan).toBeGreaterThan(firstPlan);
    expect(secondPlan).toBeLessThan(chunk);

    // tail order preserved: sources still arrive, done is last, no duplicate plan frame
    expect(frames[frames.length - 1]?.type).toBe("done");
    expect(frames.some((f) => f.type === "sources")).toBe(true);
    expect(frames.filter((f) => f.type === "plan")).toHaveLength(2);
  });
});

const metadata = { id: "plan-run", modelId: "mock", timestamp: new Date() };

/** Mock model: step 1 plan.create, step 2 plan.update, step 3 final answer text. */
function makePlanModel() {
  return new MockLanguageModelV2({
    doStream: (() => {
      let call = 0;
      return async () => {
        const current = call++;
        const chunks: LanguageModelV2StreamPart[] =
          current === 0
            ? [
                { type: "stream-start", warnings: [] },
                { type: "response-metadata", ...metadata },
                {
                  type: "tool-call",
                  toolCallId: "p1",
                  toolName: "plan",
                  input: JSON.stringify({ action: "create", steps: STEPS }),
                },
                { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
              ]
            : current === 1
              ? [
                  { type: "stream-start", warnings: [] },
                  { type: "response-metadata", ...metadata },
                  {
                    type: "tool-call",
                    toolCallId: "p2",
                    toolName: "plan",
                    input: JSON.stringify({ action: "update", step: 1, status: "done", note: "找到 3 条" }),
                  },
                  { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } },
                ]
              : [
                  { type: "stream-start", warnings: [] },
                  { type: "response-metadata", ...metadata },
                  { type: "text-start", id: "t0" },
                  { type: "text-delta", id: "t0", delta: "计划执行完成" },
                  { type: "text-end", id: "t0" },
                  { type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 } },
                ];
        return { stream: simulateReadableStream({ initialDelayInMs: 10, chunks }) };
      };
    })(),
  });
}

async function collectPlanFrames(): Promise<SseFrame[]> {
  const registry = new ToolRegistry();
  registry.register(createPlanTool(new PlanStore()));
  const runtime = new AgentRuntime(() => registry.list(), { maxConcurrent: 4, queueWaitMs: 100 });
  const agent = createReactAgent({
    name: "main",
    description: "main",
    runtime,
    toolNames: ["plan"],
    purpose: "chat",
    buildSystemPrompt: async () => "sys",
    model: makePlanModel(),
  });
  const frames: SseFrame[] = [];
  for await (const frame of agent.run({
    query: "帮我做一个复杂任务",
    scope: {},
    history: [],
    chatSessionId: "plan-session",
  })) {
    frames.push(frame);
  }
  return frames;
}
