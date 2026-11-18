import { describe, expect, it } from "vitest";
import { resolvePlanAllowedTools } from "../src/agent/dag/allowed-tools.js";
import { validatePlan } from "../src/agent/dag/graph.js";
import { buildResearchPaperGraph } from "../src/agent/dag/templates.js";
import { PlanRunner } from "../src/agent/dag/runner.js";
import type { PlanGraph } from "../src/agent/dag/types.js";
import { PlanRunEngine } from "../src/agent/dag/state.js";
import { MemoryPlanRunRepository } from "../src/repository/memory/plan-runs.js";

const ACADEMIC_TOOLS = [
  "academic_project",
  "academic_literature",
  "academic_manuscript",
  "academic_evidence",
  "academic_experiment",
  "academic_validation",
  "academic_analysis",
  "research_approval",
  "research_workspace",
  "docx_inspect",
  "vector_search",
];

describe("plan allowed tools (research pack)", () => {
 it("merges the academic tools into the planner allow-list when registered", () => {
    const tools = resolvePlanAllowedTools(ACADEMIC_TOOLS);
    expect(tools).toContain("academic_project");
    expect(tools).toContain("academic_experiment");
    expect(tools).toContain("research_workspace");
    // D1: code execution must go through the approved experiment gate, never a
    // DAG node's own run_code tool.
    expect(tools).not.toContain("run_code");
    expect(tools).not.toContain("sandbox_bash");
  });

 it("drops academic tools that are not registered at runtime", () => {
    const tools = resolvePlanAllowedTools(["vector_search"]);
    expect(tools).toEqual(["vector_search"]);
  });

 it("validates the research-paper template with the resolved runtime allow-list", () => {
    const graph = buildResearchPaperGraph({ goal: "研究 X", projectId: "p1", workspaceId: "w1" });
    const errors = validatePlan(graph, {
      builtinAgents: ["note", "code"],
      allowedTools: resolvePlanAllowedTools(ACADEMIC_TOOLS),
      maxNodes: 12,
      maxAgents: 6,
    });
    expect(errors).toEqual([]);
    const experiment = graph.nodes.find((node) => node.id === "experiment");
    expect(experiment?.requiresApproval).toBe(true);
    const experimentSpec = graph.agents.find((agent) => agent.id === "experiment");
    expect(experimentSpec?.tools).not.toContain("run_code");
  });
});

const gatedGraph: PlanGraph = {
  version: 1,
  goal: "gated",
  agents: [],
  nodes: [
    { id: "a", title: "实验", agent: "note", deps: [], task: "run experiment", acceptance: "", requiresApproval: true },
    { id: "b", title: "写作", agent: "note", deps: ["a"], task: "write", acceptance: "" },
  ],
};

function makeRunner(approved: boolean, calls: string[], engine?: PlanRunEngine) {
  const lifecycle = {
    registeredAgents: () => [{ name: "note", breaker: "closed" }],
    invokeReentrant: async (name: string) => {
      calls.push(name);
      return { content: "done", sources: [], failed: false, artifacts: [], interactions: [] };
    },
    invokeEphemeral: async () => ({ content: "", sources: [], failed: false, artifacts: [], interactions: [] }),
  };
  return new PlanRunner({
    lifecycle: lifecycle as never,
    runtime: { listToolDefs: () => [] } as never,
    prompts: { render: () => "" } as never,
    ...(engine ? { engine } : {}),
    approvalGate: async () => (approved ? { approved: true } : { approved: false, reason: "needs user" }),
    requestApproval: async () => "approval-1",
  });
}

describe("PlanRunner approval gate", () => {
 it("pauses before the gated node and creates a pending approval", async () => {
    const calls: string[] = [];
    const result = await makeRunner(false, calls).run({ graph: gatedGraph, sessionId: "s1", scope: {} });
    expect(result.paused).toBe(true);
    expect(result.approvalId).toBe("approval-1");
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

 it("persists the paused run and resumes it after approval", async () => {
    const engine = new PlanRunEngine(new MemoryPlanRunRepository());
    const firstCalls: string[] = [];
    const first = await makeRunner(false, firstCalls, engine).run({
      graph: gatedGraph,
      sessionId: "s1",
      uid: "u1",
      academicProjectId: "p1",
      scope: {},
    });
    expect(first.paused).toBe(true);
    expect(first.runId).toBeTruthy();
    const stored = await engine.get(first.runId!);
    expect(stored?.status).toBe("paused");
    expect(stored?.projectId).toBe("p1");
    expect(stored?.nodes.find((node) => node.id === "a")?.note).toContain("approval-1");

    const secondCalls: string[] = [];
    const resumed = await makeRunner(true, secondCalls, engine).resume(first.runId!);
    expect(resumed.paused).toBeUndefined();
    expect(resumed.ok).toBe(true);
    expect(secondCalls).toEqual(["note", "note"]);
    const done = await engine.get(first.runId!);
    expect(done?.status).toBe("completed");
  });

 it("cancels a paused run and refuses to cancel a terminal one", async () => {
    const engine = new PlanRunEngine(new MemoryPlanRunRepository());
    const runner = makeRunner(false, [], engine);
    const first = await runner.run({
      graph: gatedGraph,
      sessionId: "s1",
      uid: "u1",
      academicProjectId: "p1",
      scope: {},
    });
    expect(first.paused).toBe(true);
    expect(await runner.cancel(first.runId!)).toBe(true);
    const stored = await engine.get(first.runId!);
    expect(stored?.status).toBe("cancelled");
    expect(await runner.cancel(first.runId!)).toBe(false);
  });

 it("runs the gated node once the approval exists", async () => {
    const calls: string[] = [];
    const result = await makeRunner(true, calls).run({ graph: gatedGraph, sessionId: "s1", scope: {} });
    expect(result.paused).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["note", "note"]);
  });
});