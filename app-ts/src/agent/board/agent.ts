import { createReactAgent } from "../react.js";
import { agentEntry } from "../manifest.js";
import type { PromptRegistry } from "../prompts/loader.js";
import type { AgentContextBinding } from "../react.js";
import type { AgentRuntime } from "../../tools/runtime.js";

/** Board agent: manipulates mind maps/whiteboards (sub-agent invoked via delegate_to_agent; mirrors the Python §2.12 red lines). */
export function createBoardAgent(runtime: AgentRuntime, prompts: PromptRegistry, context?: AgentContextBinding) {
  return createReactAgent({
    name: "board",
    description: agentEntry("board").description,
    runtime,
    toolNames: ["list_boards", "get_board", "create_board", "update_board", "delete_board", "ask_user"],
    purpose: "board",
    context,
    buildSystemPrompt: () => Promise.resolve(prompts.render("board", {})),
  });
}
