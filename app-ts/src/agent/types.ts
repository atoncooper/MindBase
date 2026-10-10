import type { SearchScope } from "../context/types.js";
import type { SseFrame } from "../transport/sse.js";

/** Common agent contract: streaming execution, emits SSE frames. */
export interface AgentInvokeInput {
  query: string;
  uid?: string;
  chatSessionId?: string;
  scope: SearchScope;
  /** Recent conversation history (excluding the current query) */
  history: Array<{ role: "user" | "assistant"; content: string; images?: string[] }>;
  /** Client-supplied system directives appended to the agent's own system prompt (OpenAI-compat endpoint) */
  extraSystem?: string;
  /** Attached images for this turn (data URLs, vision-gated upstream) */
  images?: string[];
  /** User-selected installed skills forced into the system prompt this turn */
  skillIds?: string[];
}

export interface Agent {
  name: string;
  description: string;
  run(input: AgentInvokeInput): AsyncGenerator<SseFrame>;
}

export type AgentFactory = () => Agent;
