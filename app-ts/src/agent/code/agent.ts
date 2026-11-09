import { createReactAgent } from "../react.js";
import { agentEntry } from "../manifest.js";
import type { PromptRegistry } from "../prompts/loader.js";
import type { AgentContextBinding, ReactAgentOptions } from "../react.js";
import type { AgentRuntime } from "../../tools/runtime.js";

/**
 * Code agent: writes code and tries sandbox verification via run_code
 * (sub-agent invoked via delegate_to_agent).
 *
 * The optional `resolveModel` hook lets the composition root route this agent
 * to the user's own Coding Plan; undefined/failed resolution keeps the platform
 * gateway model (fail-open).
 */
export function createCodeAgent(
  runtime: AgentRuntime,
  prompts: PromptRegistry,
  context?: AgentContextBinding,
  resolveModel?: ReactAgentOptions["resolveModel"],
) {
  return createReactAgent({
    name: "code",
    description: agentEntry("code").description,
    runtime,
    toolNames: ["run_code"],
    purpose: "code",
    context,
    resolveModel,
    buildSystemPrompt: () => Promise.resolve(prompts.render("agents/code", {})),
  });
}
