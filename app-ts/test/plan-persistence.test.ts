import { describe, expect, it } from "vitest";
import { PlanRunner } from "../src/agent/dag/runner.js";
import { PlanRunEngine } from "../src/agent/dag/state.js";
import { MemoryPlanRunRepository } from "../src/repository/memory/plan-runs.js";
import type { PlanGraph } from "../src/agent/dag/types.js";

const graph: PlanGraph = {
  version: 1,
  goal: "resume",
  agents: [],
  nodes: [
    { id: "a", title: "A", agent: "note", deps: [], task: "a", acceptance: "" },
    { id: "b", title: "B", agent: "code", deps: ["a"], task: "b", acceptance: "" },
  ],
};

function lifecycle(calls: string[]) {
  return {
    registeredAgents: () => [{ name: "note", breaker: "closed" }, { name: "code", breaker: "closed" }],
    invokeReentrant: async (name: string) => {
      calls.push(name);
      return { content: name + " result", sources: [], failed: false, artifacts: [], interactions: [] };
    },
    invokeEphemeral: async () => ({ content: "", sources: [], failed: false, artifacts: [], interactions: [] }),
  };
}

describe("durable PlanRun", () => {
  it("persists node outputs and resumes without re-running completed nodes", async () => {
    const repo = new MemoryPlanRunRepository();
    const engine = new PlanRunEngine(repo);
    const run = await engine.create({ graph, chatSessionId: "s1" });
    // Simulate a crash: a finished, b was in flight.
    run.nodes[0]!.status = "done";
    run.nodes[0]!.output = "A persisted";
    run.nodes[1]!.status = "in_progress";
    run.status = "running";
    await engine.commit(run);

    const calls: string[] = [];
    const runner = new PlanRunner({
      lifecycle: lifecycle(calls) as never,
      runtime: { listToolDefs: () => [] } as never,
      prompts: { render: () => "" } as never,
      engine,
    });
    const result = await runner.resume(run.runId, {});
    expect(calls).toEqual(["code"]);
    expect(result.outputs.a).toBe("A persisted");
    expect(result.outputs.b).toBe("code result");
    const persisted = await repo.get(run.runId);
    expect(persisted?.status).toBe("completed");
    expect(persisted?.nodes.find((n) => n.id === "a")?.output).toBe("A persisted");
  });

  it("creates a durable run for a normal execution", async () => {
    const repo = new MemoryPlanRunRepository();
    const engine = new PlanRunEngine(repo);
    const calls: string[] = [];
    const runner = new PlanRunner({
      lifecycle: lifecycle(calls) as never,
      runtime: { listToolDefs: () => [] } as never,
      prompts: { render: () => "" } as never,
      engine,
    });
    const result = await runner.run({ graph, sessionId: "s2", uid: "1", scope: {}, academicProjectId: "p-8" });
    expect(result.runId).toBeTruthy();
    expect(runner.stats().runs).toBe(1);
    expect(runner.stats().completed).toBe(1);
    expect(runner.stats().nodes).toBe(2);
    const persisted = await repo.get(result.runId!);
    expect(persisted?.status).toBe("completed");
    expect(persisted?.nodes.every((n) => n.status === "done")).toBe(true);
    // research-workbench context is tagged on the durable record and filterable
    expect(persisted?.projectId).toBe("p-8");
    const byProject = await engine.list("1", 10, undefined, "p-8");
    expect(byProject.map((run) => run.runId)).toEqual([result.runId]);
    expect(await engine.list("1", 10, undefined, "other-project")).toEqual([]);
  });
});
