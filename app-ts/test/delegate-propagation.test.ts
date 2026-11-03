import { describe, expect, it } from "vitest";
import { AgentLifecycleManager } from "../src/agent/lifecycle.js";
import type { Agent } from "../src/agent/types.js";
import { createDelegateTool } from "../src/tools/harness/delegate.js";
import { ResultCollector } from "../src/context/types.js";
import type { ToolRunContext } from "../src/context/types.js";
import type { SseFrame } from "../src/transport/sse.js";

/**
 * Delegate propagation (P0): sub-agent outputs other than text used to be dropped
 * by invokeReentrant. The turn must keep artifacts (UI cards), token usage
 * (billing), the sub-agent's last plan snapshot and structured interactions.
 */

function fakeAgent(): Agent {
  return {
    name: "fake",
    description: "fake sub-agent",
    run: async function* () {
      yield { type: "chunk", content: "子 agent 回答" } as SseFrame;
      yield { type: "artifact", artifacts: [{ kind: "academic_project", data: { action: "brief" } }] } as SseFrame;
      yield { type: "usage", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } } as SseFrame;
      yield {
        type: "plan",
        plan: { version: 1, steps: [{ desc: "读文献", status: "done", note: "" }], done: 1, total: 1 },
      } as SseFrame;
      yield { type: "sources", sources: [{ title: "论文来源" }] } as SseFrame;
      yield { type: "done" } as SseFrame;
    },
  };
}

describe("lifecycle.invokeReentrant", () => {
  it("returns artifacts, usage, plan and sources alongside content", async () => {
    const lifecycle = new AgentLifecycleManager();
    lifecycle.register("fake", () => fakeAgent());
    const result = await lifecycle.invokeReentrant("fake", "s1", { query: "q", scope: {}, history: [] });
    expect(result.content).toContain("子 agent 回答");
    expect(result.failed).toBe(false);
    expect(result.sources).toHaveLength(1);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].kind).toBe("academic_project");
    expect(result.usage?.totalTokens).toBe(5);
    expect(result.plan?.version).toBe(1);
    expect(result.interactions).toEqual([]);
  });

  it("returns empty collections for an unregistered agent (no throw)", async () => {
    const lifecycle = new AgentLifecycleManager();
    const result = await lifecycle.invokeReentrant("ghost", "s1", { query: "q", scope: {}, history: [] });
    expect(result.failed).toBe(true);
    expect(result.artifacts).toEqual([]);
    expect(result.interactions).toEqual([]);
  });
});

describe("delegate_to_agent merges sub-agent outputs", () => {
  it("pushes artifacts, delegated usage and the sub-agent plan into the turn collector", async () => {
    const fakeLifecycle = {
      has: () => true,
      invokeReentrant: async () => ({
        content: "ok",
        sources: [],
        failed: false,
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        artifacts: [{ kind: "academic_literature", data: { action: "search" } }],
        plan: { version: 2, steps: [], done: 0, total: 1 },
        interactions: [],
      }),
    } as unknown as AgentLifecycleManager;
    const tool = createDelegateTool(fakeLifecycle, [{ name: "academic", description: "学术" }]);
    const collector = new ResultCollector();
    const ctx: ToolRunContext = { uid: "u1", chatSessionId: "s1", scope: {}, collector };
    const out = await tool.execute({ agent: "academic", message: "帮我建项目" }, ctx);
    expect(typeof out === "string" ? out : out.content).toContain("ok");
    expect(collector.artifacts).toHaveLength(1);
    expect(collector.artifacts[0].kind).toBe("academic_literature");
    expect(collector.delegatedUsage).toHaveLength(1);
    expect(collector.delegatedUsage[0].totalTokens).toBe(3);
    expect(collector.plan?.version).toBe(2);
  });

  it("does not overwrite the main turn's own plan snapshot", async () => {
    const fakeLifecycle = {
      has: () => true,
      invokeReentrant: async () => ({
        content: "ok",
        sources: [],
        failed: false,
        artifacts: [],
        plan: { version: 9, steps: [], done: 0, total: 0 },
        interactions: [],
      }),
    } as unknown as AgentLifecycleManager;
    const tool = createDelegateTool(fakeLifecycle, [{ name: "academic", description: "学术" }]);
    const collector = new ResultCollector();
    collector.setPlan({ version: 1, steps: [], done: 0, total: 0 });
    const ctx: ToolRunContext = { uid: "u1", chatSessionId: "s1", scope: {}, collector };
    await tool.execute({ agent: "academic", message: "x" }, ctx);
    expect(collector.plan?.version).toBe(1);
  });
});
