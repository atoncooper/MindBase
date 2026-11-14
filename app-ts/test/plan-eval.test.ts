import { describe, expect, it } from "vitest";
import { PlanRunner } from "../src/agent/dag/runner.js";
import { PlanRunEngine } from "../src/agent/dag/state.js";
import { MemoryPlanRunRepository } from "../src/repository/memory/plan-runs.js";
import type { PlanGraph } from "../src/agent/dag/types.js";

/**
 * Deterministic golden-plan eval.
 *
 * It does not call an LLM: the planner output is a fixture graph, and the
 * executor is asserted on ordering, parallel readiness, failure semantics and
 * resume. This is the CI-safe part of the DAG eval suite; model-driven golden
 * tasks can reuse the same harness with a recorded lifecycle.
 */
function lifecycle(scripts: Record<string, { fail?: boolean; output?: string }>, calls: string[]) {
  return {
    registeredAgents: () => Object.keys(scripts).map((name) => ({ name, breaker: "closed" })),
    invokeReentrant: async (name: string) => {
      calls.push(name);
      const spec = scripts[name] ?? {};
      const output = spec.output ?? name + " output";
      return { content: output, sources: [], failed: Boolean(spec.fail), artifacts: [], interactions: [] };
    },
    invokeEphemeral: async () => ({ content: "", sources: [], failed: false, artifacts: [], interactions: [] }),
  };
}

function runnerFor(scripts: Record<string, { fail?: boolean; output?: string }>, calls: string[]) {
  const engine = new PlanRunEngine(new MemoryPlanRunRepository());
  return new PlanRunner({
    lifecycle: lifecycle(scripts, calls) as never,
    runtime: { listToolDefs: () => [] } as never,
    prompts: { render: () => "" } as never,
    engine,
  });
}

const dependencyGraph: PlanGraph = {
  version: 1,
  goal: "dependency order",
  agents: [],
  nodes: [
    { id: "a", title: "A", agent: "note", deps: [], task: "a", acceptance: "" },
    { id: "b", title: "B", agent: "note", deps: ["a"], task: "b", acceptance: "" },
    { id: "c", title: "C", agent: "note", deps: ["b"], task: "c", acceptance: "" },
  ],
};

describe("plan eval", () => {
  it("golden: dependency chain runs in topological order", async () => {
    const calls: string[] = [];
    const result = await runnerFor({ note: {} }, calls).run({ graph: dependencyGraph, sessionId: "e1", scope: {} });
    expect(calls).toEqual(["note", "note", "note"]);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.outputs)).toEqual(["a", "b", "c"]);
  });

  it("golden: a failed node skips dependants while an independent branch completes", async () => {
    const calls: string[] = [];
    const graph: PlanGraph = {
      version: 1,
      goal: "failure isolation",
      agents: [],
      nodes: [
        { id: "a", title: "A", agent: "note", deps: [], task: "a", acceptance: "" },
        { id: "b", title: "B", agent: "code", deps: ["a"], task: "b", acceptance: "" },
        { id: "c", title: "C", agent: "note", deps: [], task: "c", acceptance: "" },
      ],
    };
    const result = await runnerFor({ note: { fail: true }, code: {} }, calls).run({ graph, sessionId: "e2", scope: {} });
    expect(result.ok).toBe(false);
    expect(result.failed).toContain("a");
    expect(result.failed).toContain("c");
    expect(result.skipped).toEqual(["b"]);
  });

  it("golden: independent ready nodes use the bounded parallel scheduler", async () => {
    const calls: string[] = [];
    const graph: PlanGraph = {
      version: 1,
      goal: "parallel",
      agents: [],
      nodes: ["a", "b", "c"].map((id) => ({ id, title: id, agent: "note", deps: [], task: id, acceptance: "" })),
    };
    const result = await runnerFor({ note: {} }, calls).run({ graph, sessionId: "e3", scope: {} });
    expect(result.ok).toBe(true);
    expect(new Set(calls)).toEqual(new Set(["note"]));
    expect(Object.keys(result.outputs)).toHaveLength(3);
  });

  it("golden: resume reuses completed output", async () => {
    const calls: string[] = [];
    const engine = new PlanRunEngine(new MemoryPlanRunRepository());
    const run = await engine.create({ graph: dependencyGraph, chatSessionId: "e4" });
    run.nodes[0]!.status = "done";
    run.nodes[0]!.output = "persisted-a";
    run.nodes[1]!.status = "done";
    run.nodes[1]!.output = "persisted-b";
    run.nodes[2]!.status = "in_progress";
    run.status = "running";
    await engine.commit(run);
    const runner = new PlanRunner({
      lifecycle: lifecycle({ note: {} }, calls) as never,
      runtime: { listToolDefs: () => [] } as never,
      prompts: { render: () => "" } as never,
      engine,
    });
    const result = await runner.resume(run.runId, {});
    expect(calls).toHaveLength(1);
    expect(result.outputs.a).toBe("persisted-a");
    expect(result.outputs.b).toBe("persisted-b");
    expect(result.outputs.c).toBe("note output");
  });
});
