import { describe, expect, it } from "vitest";
import { PlanRunner } from "../src/agent/dag/runner.js";
import type { PlanGraph } from "../src/agent/dag/types.js";

const graph: PlanGraph = {
  version: 1,
  goal: "pipeline",
  agents: [],
  nodes: [
    { id: "a", title: "A", agent: "note", deps: [], task: "a", acceptance: "" },
    { id: "b", title: "B", agent: "code", deps: ["a"], task: "b", acceptance: "" },
  ],
};

describe("PlanRunner", () => {
  it("executes dependencies in topological order and injects upstream output", async () => {
    const calls: string[] = [];
    const lifecycle = {
      registeredAgents: () => [{ name: "note", breaker: "closed" }, { name: "code", breaker: "closed" }],
      invokeReentrant: async (name: string, _session: string, input: { query: string }) => {
        calls.push(name);
        if (name === "code") expect(input.query).toContain("A 的结果");
        return { content: name === "note" ? "A 的结果" : "B 的结果", sources: [], failed: false, artifacts: [], interactions: [] };
      },
      invokeEphemeral: async () => ({ content: "", sources: [], failed: false, artifacts: [], interactions: [] }),
    };
    const runner = new PlanRunner({
      lifecycle: lifecycle as never,
      runtime: { listToolDefs: () => [1] } as never,
      prompts: { render: () => "" } as never,
    });
    const updates: string[] = [];
    const result = await runner.run({
      graph,
      sessionId: "s1",
      scope: {},
      onUpdate: (snapshot) => {
        const statuses = (snapshot.nodes ?? []).map((n) => n.id + ":" + n.status).join(",");
        updates.push(statuses);
      },
    });
    expect(updates.some((u) => u.includes("a:in_progress"))).toBe(true);
    expect(updates.some((u) => u.includes("b:in_progress"))).toBe(true);
    expect(updates.at(-1)).toContain("b:done");
    expect(calls).toEqual(["note", "code"]);
    expect(result.ok).toBe(true);
    expect(result.outputs.b).toContain("B 的结果");
  });

  it("skips dependants when a node fails", async () => {
    const lifecycle = {
      registeredAgents: () => [{ name: "note", breaker: "closed" }, { name: "code", breaker: "closed" }],
      invokeReentrant: async (name: string) => ({
        content: name === "note" ? "boom" : "should not run",
        sources: [],
        failed: name === "note",
        artifacts: [],
        interactions: [],
      }),
      invokeEphemeral: async () => ({ content: "", sources: [], failed: false, artifacts: [], interactions: [] }),
    };
    const runner = new PlanRunner({
      lifecycle: lifecycle as never,
      runtime: { listToolDefs: () => [1] } as never,
      prompts: { render: () => "" } as never,
    });
    const result = await runner.run({ graph, sessionId: "s1", scope: {} });
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual(["a"]);
    expect(result.skipped).toEqual(["b"]);
  });
});
