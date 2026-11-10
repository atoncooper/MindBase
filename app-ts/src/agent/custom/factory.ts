import { createReactAgent } from "../react.js";
import type { Agent } from "../types.js";
import type { AgentRuntime } from "../../tools/runtime.js";
import type { PromptRegistry } from "../prompts/loader.js";
import type { CustomAgentSpec, PlanNode } from "../dag/types.js";
import { config } from "../../config/index.js";

export interface CustomAgentDeps {
  runtime: AgentRuntime;
  prompts: PromptRegistry;
}

export interface UpstreamResult {
  id: string;
  title: string;
  output: string;
}

/** Render dependency outputs as a bounded, clearly delimited context section. */
export function renderUpstream(upstream: UpstreamResult[]): string {
  if (upstream.length === 0) return "（无上游依赖）";
  return upstream
    .map((item) => "### 上游节点：" + item.title + " (" + item.id + ")\n" + item.output.slice(0, 4000))
    .join("\n\n");
}

/**
 * Build one ephemeral custom agent: a normal ReAct loop whose system prompt is
 * assembled from the planner-authored role/instructions plus dependency output
 * and acceptance criteria. The agent is never registered globally.
 */
export function createCustomAgent(
  spec: CustomAgentSpec,
  node: PlanNode,
  upstream: UpstreamResult[],
  deps: CustomAgentDeps,
): Agent {
  return createReactAgent({
    name: "custom-" + spec.id,
    description: spec.name + "：" + spec.role,
    runtime: deps.runtime,
    toolNames: spec.tools,
    purpose: "custom_agent",
    maxSteps: spec.max_steps ?? config.agent.plan.customAgentMaxSteps,
    async buildSystemPrompt() {
      return deps.prompts.render("agents/custom", {
        ROLE: spec.role,
        NAME: spec.name,
        SYSTEM_PROMPT: spec.system_prompt,
        TASK: node.task,
        ACCEPTANCE: node.acceptance || "（无额外验收标准，按任务描述完成）",
        UPSTREAM_RESULTS: renderUpstream(upstream),
      });
    },
  });
}
