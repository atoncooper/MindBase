import { createReactAgent } from "../react.js";
import { agentEntry } from "../manifest.js";
import type { PromptRegistry } from "../prompts/loader.js";
import type { AgentContextBinding } from "../react.js";
import type { AgentRuntime } from "../../tools/runtime.js";

/** Quiz agent: question generation/grading (sub-agent invoked via delegate_to_agent; mirrors the Python non-routing-target positioning). */
export function createQuizAgent(runtime: AgentRuntime, prompts: PromptRegistry, context?: AgentContextBinding) {
  return createReactAgent({
    name: "quiz",
    description: agentEntry("quiz").description,
    runtime,
    // 大脑化：可自主收集素材（知识库检索 + 联网搜索/抓页）后再结构化出题/批改
    toolNames: ["emit_quiz", "emit_grading", "vector_search", "web_search", "fetch_webpage"],
    purpose: "quiz",
    context,
    buildSystemPrompt: () => Promise.resolve(prompts.render("agents/quiz", {})),
  });
}
