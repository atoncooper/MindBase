import { createReactAgent } from "../react.js";
import { agentEntry } from "../manifest.js";
import { buildMemorySection } from "../../context/memory.js";
import type { PromptRegistry } from "../prompts/loader.js";
import type { AgentContextBinding } from "../react.js";
import type { AgentRuntime } from "../../tools/runtime.js";
import type { MemoryRepository } from "../../repository/memory-store.js";

/**
 * Academic sub-agent factory.
 *
 * Role: research assistant for the user's own projects — stage/plan/advice
 * workflow, literature search + verification (Crossref/OpenAlex/arXiv, BibTeX
 * import/export) and manuscript section read/write. Behaviour parity target:
 * mind-base-desktop AgentKind::Academic plus the project workflow of
 * AgentKind::Research.
 *
 * Layer: agent factory. It declares only identity, tool surface and prompt
 * source; the loop, retries and SSE framing come from the shared
 * `createReactAgent`. This is a delegate-only sub-agent: `main` reaches it via
 * `delegate_to_agent`, so it is never an orchestrator routing target.
 *
 * Context (mirrors what main receives, which sub-agents used to miss):
 *  - long-term memory recall is injected per turn when a MemoryRepository is wired;
 *  - the user's installed-skill index rides on the system prompt (prompt-as-data);
 *  - vector_search is exposed so academic writing can cite the user's own
 *    knowledge base (course videos / cloud documents), not only the library.
 */
const ACADEMIC_TOOLS = [
  "academic_project",
  "academic_literature",
  "academic_manuscript",
  "academic_evidence",
  "run_code",
  "vector_search",
  "web_search",
  "fetch_webpage",
  "plan",
  "save_memory",
];

export interface AcademicAgentOptions {
  /** per-agent context binding (own distilled history + shared session summary) */
  context?: AgentContextBinding;
  /** long-term memory store; absent → no recall section (writes still work via save_memory) */
  memoryStore?: MemoryRepository;
  /** renders the installed-skills index section for this user; absent → no skills section */
  skillsSection?: (uid: string) => Promise<string>;
}

/**
 * Build the "academic" ReAct agent.
 *
 * @param runtime shared tool runtime; only `ACADEMIC_TOOLS` are exposed to the model.
 * @param prompts prompt registry; system prompt = prompts/agents/academic.md.
 * @param options context binding, memory recall and skills injection (all optional).
 */
export function createAcademicAgent(
  runtime: AgentRuntime,
  prompts: PromptRegistry,
  options: AcademicAgentOptions = {},
) {
  return createReactAgent({
    name: "academic",
    description: agentEntry("academic").description,
    runtime,
    toolNames: ACADEMIC_TOOLS,
    purpose: "academic",
    context: options.context,
    async buildSystemPrompt(input) {
      let system = prompts.render("agents/academic", {});
      if (options.memoryStore && input.uid !== undefined) {
        try {
          system += await buildMemorySection(options.memoryStore, input.uid, input.query);
        } catch {
          // Memory recall is best-effort context, never a reason to fail the turn.
        }
      }
      if (options.skillsSection && input.uid !== undefined) {
        try {
          const section = await options.skillsSection(input.uid);
          if (section) system += "\n" + section;
        } catch {
          // Skills index is optional context; degrade silently like main's builder.
        }
      }
      return system;
    },
  });
}
