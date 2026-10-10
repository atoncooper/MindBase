import { createReactAgent } from "../react.js";
import { agentEntry } from "../manifest.js";
import type { PromptRegistry } from "../prompts/loader.js";
import type { AgentContextBinding } from "../react.js";
import type { AgentRuntime } from "../../tools/runtime.js";

/** Code agent: writes code and tries sandbox verification via run_code (sub-agent invoked via delegate_to_agent). */
export function createCodeAgent(runtime: AgentRuntime, prompts: PromptRegistry, context?: AgentContextBinding) {
  return createReactAgent({
    name: "code",
    description: agentEntry("code").description,
    runtime,
    toolNames: ["run_code"],
    purpose: "code",
    context,
    buildSystemPrompt: () => Promise.resolve(prompts.render("code", {})),
  });
}
