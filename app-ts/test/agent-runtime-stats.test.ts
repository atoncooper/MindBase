import { describe, it, expect } from "vitest";
import type { Agent, AgentInvokeInput } from "../src/agent/types.js";
import type { SseFrame } from "../src/transport/sse.js";
import { AgentLifecycleManager } from "../src/agent/lifecycle.js";

/**
 * Per-agent runtime statistics on the lifecycle layer: runs/ok/failed/retries/
 * active/lastError, breaker-rejected calls, and active session locks — the
 * data surfaced by /agent/runtime (agent_metrics / agent_breakers / session_locks).
 */

/** Scripted agent: yields the given frames (Factory pattern = fresh per run). */
function scriptedAgent(frames: SseFrame[]): { factory: () => Agent; runs: () => number } {
  let runs = 0;
  return {
    runs: () => runs,
    factory: () => {
      runs += 1;
      return {
        name: "scripted",
        description: "scripted",
        run: async function* (): AsyncGenerator<SseFrame> {
          for (const f of frames) yield f;
        },
      };
    },
  };
}

const input: AgentInvokeInput = { query: "问", scope: {}, history: [] };

describe("AgentLifecycleManager runtime stats", () => {
  it("successful run → runs=1 ok=1, active returns to 0", async () => {
    const lifecycle = new AgentLifecycleManager();
    const { factory } = scriptedAgent([
      { type: "chunk", content: "答" },
      { type: "done" },
    ]);
    lifecycle.register("main", factory);

    for await (const _ of lifecycle.stream("main", "s1", input)) void _;

    const stat = lifecycle.agentStats().main!;
    expect(stat).toMatchObject({ runs: 1, ok: 1, failed: 0, active: 0, retries: 0 });
    expect(stat.lastRunAt).toBeDefined();
  });

  it("error frame counts failed + lastError; reset counts retries", async () => {
    const lifecycle = new AgentLifecycleManager();
    const { factory } = scriptedAgent([
      { type: "reset" },
      { type: "error", message: "网关 502" },
      { type: "done" },
    ]);
    lifecycle.register("main", factory);

    for await (const _ of lifecycle.stream("main", "s1", input)) void _;

    expect(lifecycle.agentStats().main).toMatchObject({
      runs: 1, failed: 1, retries: 1, lastError: "网关 502",
    });
  });

  it("breaker-rejected calls are counted separately (not runs)", async () => {
    const lifecycle = new AgentLifecycleManager();
    const { factory } = scriptedAgent([
      { type: "error", message: "e1" },
      { type: "done" },
    ]);
    lifecycle.register("main", factory);

    // threshold = 3 consecutive failures → open
    for (let i = 0; i < 3; i++) {
      for await (const _ of lifecycle.stream("main", `s${i}`, input)) void _;
    }
    expect(lifecycle.agentBreakers().main.state).toBe("open");

    const before = lifecycle.agentStats().main;
    for await (const frame of lifecycle.stream("main", "sx", input)) {
      if (frame.type === "error") expect(frame.message).toContain("熔断中");
    }
    const after = lifecycle.agentStats().main;
    expect(after.breakerTripped).toBe(1);
    expect(after.runs).toBe(before.runs); // rejected calls never ran
    expect(lifecycle.agentBreakers().main.recoveryInMs).toBeGreaterThan(0);
  });

  it("invokeReentrant feeds the same stats (sub-agent visibility)", async () => {
    const lifecycle = new AgentLifecycleManager();
    const { factory } = scriptedAgent([
      { type: "chunk", content: "子结果" },
      { type: "done" },
    ]);
    lifecycle.register("note", factory);

    await lifecycle.invokeReentrant("note", "s1", input);
    await lifecycle.invokeReentrant("note", "s1", input);

    expect(lifecycle.agentStats().note).toMatchObject({ runs: 2, ok: 2, active: 0 });
  });

  it("activeLocks reflects in-flight streams", async () => {
    const lifecycle = new AgentLifecycleManager();
    let probe: (() => void) | null = null;
    const { factory } = scriptedAgent([{ type: "done" }]);
    void factory;
    // agent that reports the lock count from inside the run
    lifecycle.register("probe", () => ({
      name: "probe",
      description: "probe",
      run: async function* (): AsyncGenerator<SseFrame> {
        probe = () => lifecycle.activeLocks();
        yield { type: "chunk", content: "running" };
      },
    }));

    let observed = -1;
    for await (const frame of lifecycle.stream("probe", "lock-session", input)) {
      if (frame.type === "chunk") observed = probe!();
    }
    expect(observed).toBe(1); // held during the run
    expect(lifecycle.activeLocks()).toBe(0); // released after
  });
});
