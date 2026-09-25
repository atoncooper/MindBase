// Shared chat types for the frontendv2 chat view.

import type { ChatArtifact, ChatSource } from "@/lib/chat-stream";

export interface ReasoningStep {
  step: number;
  action: string;
  query?: string;
  reasoning?: string;
  verdict?: string;
  recall_score?: number;
  sources: ChatSource[];
}

export type MessageStatus = "pending" | "completed" | "failed";

export interface ChatMessageData {
  id: string;
  // Real backend msg_id, backfilled after a streamed turn completes (the SSE
  // protocol carries no ids). Used by per-turn regenerate to address server
  // history; `id` stays a stable local key so React doesn't remount the row.
  serverId?: string;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  // Binary artifacts (e.g. images) produced by sub-agents like the code agent;
  // rendered inline below the text answer.
  artifacts?: ChatArtifact[];
  reasoningSteps?: ReasoningStep[];
  // Thinking-model reasoning stream (`reasoning` SSE frame); rendered in a
  // collapsed block, content loads on expand. Not persisted by the backend,
  // so it disappears on history reload.
  reasoning?: string;
  // Agent name routed to by AgentOrchestrator (from the `route` SSE frame).
  agent?: string;
  status: MessageStatus;
  error?: string;
  timestamp: string;
}

// Minimal session shape used by the history sidebar.
export interface ChatSessionSummary {
  id: string;
  title: string;
  lastMessageAt: string;
}
