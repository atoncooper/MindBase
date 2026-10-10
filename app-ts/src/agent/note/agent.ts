import { createReactAgent } from "../react.js";
import { agentEntry } from "../manifest.js";
import type { PromptRegistry } from "../prompts/loader.js";
import type { AgentContextBinding } from "../react.js";
import type { AgentRuntime } from "../../tools/runtime.js";

/** Note agent: organizes markdown notes and persists them via save_note (sub-agent invoked via delegate_to_agent). */
export function createNoteAgent(runtime: AgentRuntime, prompts: PromptRegistry, context?: AgentContextBinding) {
  return createReactAgent({
    name: "note",
    description: agentEntry("note").description,
    runtime,
    toolNames: ["save_note"],
    purpose: "note",
    context,
    buildSystemPrompt: () => Promise.resolve(prompts.render("note", {})),
  });
}
