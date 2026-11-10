import { describe, expect, it } from "vitest";
import { topoLayers, validatePlan } from "../src/agent/dag/graph.js";
import type { PlanGraph } from "../src/agent/dag/types.js";

const opts = {
  builtinAgents: ["main", "note", "code"],
  allowedTools: ["vector_search", "save_note"],
  maxNodes: 12,
  maxAgents: 6,
};

function graph(partial?: Partial<PlanGraph>): PlanGraph {
  return {
    version: 1,
    goal: "test",
    agents: [],
    nodes: [
      { id: "a", title: "A", agent: "note", deps: [], task: "do a", acceptance: "" },
      { id: "b", title: "B", agent: "code", deps: ["a"], task: "do b", acceptance: "" },
    ],
    ...partial,
  };
}

describe("plan graph", () => {
  it("accepts a valid DAG and computes topological layers", () => {
    expect(validatePlan(graph(), opts)).toEqual([]);
    expect(topoLayers(graph())).toEqual([["a"], ["b"]]);
  });

  it("rejects cycles", () => {
    const cyclic = graph({
      nodes: [
        { id: "a", title: "A", agent: "note", deps: ["b"], task: "a", acceptance: "" },
        { id: "b", title: "B", agent: "note", deps: ["a"], task: "b", acceptance: "" },
      ],
    });
    expect(validatePlan(cyclic, opts).map((e) => e.code)).toContain("cycle");
    expect(topoLayers(cyclic)).toBeNull();
  });

  it("rejects unknown agent/tool and duplicate ids", () => {
    const bad = graph({
      agents: [
        { id: "x", name: "X", role: "r", system_prompt: "p", tools: ["nope"] },
      ],
      nodes: [
        { id: "a", title: "A", agent: "x", deps: [], task: "a", acceptance: "" },
        { id: "a", title: "A2", agent: "unknown", deps: [], task: "a2", acceptance: "" },
      ],
    });
    const codes = validatePlan(bad, opts).map((e) => e.code);
    expect(codes).toContain("agent_tool");
    expect(codes).toContain("node_duplicate");
    expect(codes).toContain("node_agent");
  });
});
