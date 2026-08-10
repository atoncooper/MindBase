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
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  // Binary artifacts (e.g. images) produced by sub-agents like the code agent;
  // rendered inline below the text answer.
  artifacts?: ChatArtifact[];
  reasoningSteps?: ReasoningStep[];
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
