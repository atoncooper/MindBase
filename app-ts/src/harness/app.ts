import type { SearchScope } from "../context/types.js";
import type { AgentOrchestrator } from "../agent/orchestrator.js";
import type { AgentLifecycleManager } from "../agent/lifecycle.js";
import type { AgentRuntime } from "../tools/runtime.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SseFrame } from "../transport/sse.js";

/**
 * AgentHarness assembly facade (mirrors Python harness/app.py):
 * composition of, and the single entry point to, registry + runtime + orchestrator + lifecycle.
 * Upper layers (HTTP/chat service) must not bypass it and call agents directly.
 */
export class AgentHarness {
  constructor(
    readonly registry: ToolRegistry,
    readonly runtime: AgentRuntime,
    readonly orchestrator: AgentOrchestrator,
    readonly lifecycle: AgentLifecycleManager,
  ) {}

  /** Streaming dispatch: LLM routing picks the agent → route frame → agent frame stream wrapped by lifecycle */
  async *dispatchStream(input: {
    sessionId: string;
    /** Overrides the context key: undefined = stateless turn (no agent-context binding, e.g. OpenAI-compat endpoint) */
    chatSessionId?: string;
    query: string;
    uid?: string;
    scope: SearchScope;
    history: Array<{ role: "user" | "assistant"; content: string; images?: string[] }>;
    /** Skips LLM routing when an agent is explicitly specified (mirrors the Python agent_name override) */
    agentName?: string;
    /** user-selected installed skills forced into the system prompt */
    skillIds?: string[];
    /** turn-level system directive appended to the agent's own prompt (e.g. board chat context) */
    extraSystem?: string;
  }): AsyncGenerator<SseFrame> {
    const agentName = input.agentName ?? (await this.orchestrator.route(input.query));
    yield { type: "route", agent: agentName };
    yield* this.lifecycle.stream(agentName, input.sessionId, {
      query: input.query,
      uid: input.uid,
      chatSessionId: input.chatSessionId ?? input.sessionId,
      scope: input.scope,
      history: input.history,
      skillIds: input.skillIds,
      ...(input.extraSystem ? { extraSystem: input.extraSystem } : {}),
    });
  }

  /** /agent/runtime data surface: agents, per-agent metrics/breakers, tool registry, tool metrics, tool gate */
  runtimeStatus() {
    return {
      agents: this.lifecycle.registeredAgents(),
      agent_metrics: this.lifecycle.agentStats(),
      agent_breakers: this.lifecycle.agentBreakers(),
      session_locks: this.lifecycle.activeLocks(),
      registered_tools: this.registry.names(),
      tool_metrics: this.runtime.monitor(),
      tool_gate: this.runtime.gateStats(),
      tool_breakers: this.runtime.breakerStates(),
    };
  }
}
