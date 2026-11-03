import { describe, expect, it } from "vitest";
import { createDelegateTool } from "../src/tools/harness/delegate.js";
import { PromptRegistry } from "../src/agent/prompts/loader.js";
import { SUB_AGENTS, agentEntry } from "../src/agent/manifest.js";
import { createAcademicAgent } from "../src/agent/academic/agent.js";
import type { AgentLifecycleManager } from "../src/agent/lifecycle.js";
import type { AgentRuntime } from "../src/tools/runtime.js";

/**
 * Wiring guards for the academic sub-agent (plan/1.0.17 Phase 1):
 *  - the manifest is the single source for the delegate roster;
 *  - the agent factory is bound to the academic prompt;
 *  - the real prompt registry ships prompts/agents/academic.md.
 */
describe("academic agent wiring", () => {
  it("registers academic as a sub-agent in the manifest", () => {
    const entry = SUB_AGENTS.find((a) => a.name === "academic");
    expect(entry).toBeTruthy();
    expect(entry?.subAgent).toBe(true);
    expect(entry?.description).toContain("学术");
  });

  it("exposes academic in the delegate_to_agent roster", () => {
    const tool = createDelegateTool(
      {} as AgentLifecycleManager,
      SUB_AGENTS.map(({ name, description }) => ({ name, description })),
    );
    expect(tool.description).toContain("- academic:");
  });

  it("creates an agent named academic with the manifest description", () => {
    const prompts = { render: () => "SYSTEM" } as unknown as PromptRegistry;
    const agent = createAcademicAgent({} as AgentRuntime, prompts);
    expect(agent.name).toBe("academic");
    expect(agent.description).toBe(agentEntry("academic").description);
  });

  it("ships a non-trivial academic system prompt", () => {
    const real = PromptRegistry.load();
    expect(real.has("agents/academic")).toBe(true);
    const text = real.render("agents/academic", {});
    expect(text.length).toBeGreaterThan(200);
    expect(text).toContain("引用");
  });
});
