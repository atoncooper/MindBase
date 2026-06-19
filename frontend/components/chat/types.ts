// Shared chat types used by ChatPanel, ChatDockPanel, and ChatContent.

import type { ChatSource } from "@/lib/chat-stream";

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
  reasoningSteps?: ReasoningStep[];
  status: MessageStatus;
  error?: string;
  timestamp: string;
}
