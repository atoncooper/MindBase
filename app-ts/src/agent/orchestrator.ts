import { generateText } from "ai";
import { aiTelemetry } from "../llm/tracing.js";
import { config } from "../config/index.js";
import { createGatewayModel } from "../llm/provider.js";
import type { Agent } from "./types.js";
import type { PromptRegistry } from "./prompts/loader.js";
import { createLogger } from "../logger.js";

/**
 * AgentOrchestrator: LLM meta-router (mirrors Python harness/orchestrator.py).
 * Short-circuits when there is only one agent; otherwise lets the LLM pick from descriptions within a 3s timeout, falling back to the default on parse failure.
 * Router system prompt lives in prompts/router.md ({{AGENTS_LIST}} / {{DEFAULT_AGENT}} rendered per call).
 */
const log = createLogger("ORCHESTRATOR");

export class AgentOrchestrator {
  private readonly agents = new Map<string, { description: string; isDefault: boolean }>();
  private defaultAgent = "";

  constructor(private readonly prompts: PromptRegistry) {}

  register(agent: Agent, isDefault = false): void {
    this.agents.set(agent.name, { description: agent.description, isDefault });
    if (isDefault || !this.defaultAgent) {
      this.defaultAgent = agent.name;
    }
  }

  get registered(): string[] {
    return [...this.agents.keys()];
  }

  async route(query: string): Promise<string> {
    if (this.agents.size <= 1) {
      return this.defaultAgent;
    }
    try {
      const descriptions = [...this.agents.entries()]
        .map(([name, { description }]) => `- ${name}: ${description}`)
        .join("\n");
      const result = await generateText({
        model: createGatewayModel("agent_route"),
        system: this.prompts.render("agents/router", {
          AGENTS_LIST: descriptions,
          DEFAULT_AGENT: this.defaultAgent,
        }),
        prompt: query.slice(0, 500),
        temperature: 0,
        ...aiTelemetry("agent.route"),
        abortSignal: AbortSignal.timeout(config.agent.routingTimeoutMs),
      });
      const chosen = result.text.trim().match(/[\w-]+/)?.[0] ?? "";
      if (this.agents.has(chosen)) return chosen;
    } catch (err) {
      log.warn(`[ORCHESTRATOR] route failed, fallback to default: ${err instanceof Error ? err.message : err}`);
    }
    return this.defaultAgent;
  }
}
