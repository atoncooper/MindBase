/**
 * Typed access to the conversation commands
 * (`chat_sessions_*` / `chat_history` / `chat_ask` on the Rust side).
 *
 * A turn streams back through a Tauri `Channel` as {@link ChatEvent}s:
 * `chunk` (answer deltas) → `sources` (retrieved provenance, capped at 5)
 * → `done`; `title` fires when the session earns an auto-generated name and
 * `error` on failure. Both sides of the turn are persisted by the backend,
 * so a reload of history is always authoritative.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

/** One conversation in the sidebar. */
export interface ChatSessionRow {
  chatSessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
}

/** Provenance entry attached to an assistant message. */
export interface ChatSource {
  title: string;
  pageTitle: string;
  score: number;
  bvid: string;
  url: string;
  pageIndex: number;
}

/** One persisted message of a conversation. */
export interface ChatMessageRow {
  msgId: string;
  chatSessionId: string;
  role: "user" | "assistant";
  content: string;
  status: "pending" | "completed" | "failed";
  sources: ChatSource[];
  model: string;
  error: string;
  createdAt: number;
}

/** Stream frames emitted during one turn. */
export type ChatEvent =
  | { type: "step"; step: number; action: string; query: string }
  | { type: "subStep"; step: number; agent: string; action: string; query: string }
  | { type: "chunk"; content: string }
  | { type: "sources"; sources: ChatSource[] }
  | { type: "title"; title: string }
  | { type: "done"; msgId: string }
  | { type: "error"; message: string };

/** Final outcome of one completed turn. */
export interface ChatTurnResult {
  msgId: string;
  answer: string;
}

/** List active conversations, most recently updated first. */
export function listSessions(): Promise<ChatSessionRow[]> {
  return invoke<ChatSessionRow[]>("chat_sessions_list");
}

/** Create a conversation; omit the title for the 新对话 default. */
export function createSession(title?: string): Promise<ChatSessionRow> {
  return invoke<ChatSessionRow>("chat_session_create", { title: title ?? null });
}

/** Rename a conversation; empty titles are rejected backend-side. */
export function renameSession(sessionId: string, title: string): Promise<void> {
  return invoke<void>("chat_session_rename", { sessionId, title });
}

/** Delete a conversation together with every message. */
export function deleteSession(sessionId: string): Promise<void> {
  return invoke<void>("chat_session_delete", { sessionId });
}

/** Load all messages of one conversation, oldest first. */
export function getHistory(sessionId: string): Promise<ChatMessageRow[]> {
  return invoke<ChatMessageRow[]>("chat_history", { sessionId });
}

/**
 * Ask one grounded question. Resolves with the finished assistant message id
 * while streaming progress through `onEvent` meanwhile.
 * `skill` 非空时该技能全文被强制注入本轮（输入框 / 菜单选择）。
 */
export async function chatAsk(
  sessionId: string,
  question: string,
  onEvent: (event: ChatEvent) => void,
  /** null = 跟随 API 设置的默认提供方。 */
  provider: string | null = null,
  /** null = 不注入技能。 */
  skill: string | null = null,
): Promise<ChatTurnResult> {
  const channel = new Channel<ChatEvent>();
  channel.onmessage = onEvent;
  return invoke<ChatTurnResult>("chat_ask", {
    sessionId,
    question,
    provider,
    skill,
    onEvent: channel,
  });
}

/**
 * Abort the in-flight generation of one session. Resolves to whether a turn
 * was live; the turn ends gracefully, keeping whatever already streamed.
 */
export async function stopChat(sessionId: string): Promise<boolean> {
  return invoke<boolean>("stop_chat", { sessionId });
}

/**
 * Stream a structured summary of one session (summary agent). Progress flows
 * through `onEvent` (chunk/done/error); resolves when generation finishes.
 * 成功结束后后端会落库一份，供下次 `getSavedSummary` 秒开回看。
 */
export async function summarizeSession(
  sessionId: string,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const channel = new Channel<ChatEvent>();
  channel.onmessage = onEvent;
  await invoke<void>("chat_summarize", { sessionId, onEvent: channel });
}

/** One persisted summary document（每个会话保留最新一份）. */
export interface SavedSummary {
  sessionId: string;
  content: string;
  messageCount: number;
  /** Epoch seconds of the last generation. */
  createdAt: number;
}

/** 上次持久化的会话总结；null = 从未生成过。 */
export function getSavedSummary(sessionId: string): Promise<SavedSummary | null> {
  return invoke<SavedSummary | null>("chat_summary_get", { sessionId });
}
