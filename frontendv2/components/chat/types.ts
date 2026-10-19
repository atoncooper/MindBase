// Shared chat types for the frontendv2 chat view.

import type { ChatArtifact, ChatInteraction, ChatSource } from "@/lib/chat-stream";

export interface ReasoningStep {
  step: number;
  action: string;
  query?: string;
  reasoning?: string;
  verdict?: string;
  recall_score?: number;
  sources: ChatSource[];
  /** compact JSON args preview (step start frames, truncated) */
  args?: string;
  /** tool execution duration in ms (step done frames) */
  durationMs?: number;
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
  // Turn is waiting in the backend admission queue (from the `queue` SSE
  // frame, 1-based position). Cleared when the slot is granted (route/chunk
  // frames follow); if the wait times out the turn fails with a queue error.
  queuePosition?: number;
  // Sub-agent delegation live status (from the `delegate` SSE frame): the
  // currently-running sub-agent name + how many are active. Cleared when the
  // delegation finishes (active=0).
  subAgent?: { agent: string; count: number };
  // Structured AI→user interaction (ask_user → `interact` SSE frame): the
  // confirm card / option chips / form rendered under the assistant text.
  // Not persisted by the backend — disappears on history reload (same as
  // reasoning streams).
  interaction?: ChatInteraction;
  // The user already answered this interaction (answer sent as the next
  // ordinary user message); the card renders in a settled state afterwards.
  interactionAnswered?: boolean;
  status: MessageStatus;
  // 多模态：用户消息附带的图片（data URL，仅本地实时态；历史重载后不含）
  images?: string[];
  error?: string;
  timestamp: string;
}

// Minimal session shape used by the history sidebar.
export interface ChatSessionSummary {
  id: string;
  title: string;
  lastMessageAt: string;
}
