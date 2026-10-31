/**
 * Typed access to the conversation commands
 * (`chat_sessions_*` / `chat_history` / `chat_ask` on the Rust side).
 *
 * A turn streams back through a Tauri `Channel` as {@link ChatEvent}s:
 * `chunk` (answer deltas) → `sources` (retrieved provenance, capped at 5)
 * → `artifact` / `usage` (本轮产物与 token 用量) → `done`; `title` fires
 * when the session earns an auto-generated name and `error` on failure.
 * Both sides of the turn are persisted by the backend, so a reload of
 * history is always authoritative (usage included).
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

/** 一轮 LLM 调用的 token 用量（工具轮次与子代理已聚合；字段可能缺省）。 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** 缓存命中 token（DeepSeek prompt_cache_hit_tokens / OpenAI cached_tokens）。 */
  cachedTokens?: number;
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
  /** 该助手消息的 token 用量；用户消息 / 未计量轮次为 null。 */
  usage?: TokenUsage | null;
}

/** 交互卡片的三种形态：单选澄清 / 确认执行 / 结构化表单。 */
export type InteractionKind = "clarify" | "confirm" | "form";

/** 澄清选项 / 确认按钮：label 用于展示，value 作为下一条用户消息发送。 */
export interface InteractionOption {
  label: string;
  value: string;
}

/** 表单字段（type 决定控件；select 用 options 作下拉项）。 */
export interface InteractionField {
  name: string;
  label: string;
  type: "text" | "email" | "datetime" | "select";
  /** 必填项：未填写时提交按钮置灰。空集合时 Rust 可能省略。 */
  required?: boolean;
  options?: InteractionOption[];
}

/**
 * ask_user 触发的交互卡片（Rust 侧 `ChatEvent::Interact`）。
 * 本轮随即结束，用户作答即作为**下一条用户消息**发送。
 * options / fields 按形态取舍，空集合时 Rust 可能省略，故按可选处理。
 */
export interface ChatInteraction {
  kind: InteractionKind;
  question: string;
  options?: InteractionOption[];
  fields?: InteractionField[];
  context?: string;
}

/** 本轮新生成的产物（exports/ 下的文件，与 exports_list 同构）。 */
export interface ChatArtifact {
  name: string;
  path: string;
  /** "markdown" | "pptx" | raw extension for anything else. */
  kind: string;
  sizeBytes: number;
  /** File mtime, epoch seconds. */
  modifiedAt: number;
}

/** 后端 chat_live_state：进行中回合的实时快照（切走/切回恢复用）。 */
export interface LiveChatState {
  sessionId: string;
  question: string;
  answer: string;
  steps: { step: number; action: string; query: string }[];
  subSteps: { step: number; agent: string; action: string; query: string }[];
  liveAgent?: { name: string; action: string; step: number } | null;
  plan?: { version: number; steps: { desc: string; status: string; note: string }[] } | null;
  startedAt: number;
}

/** 读取正在进行的回合（None = 当前没有在跑）。 */
export function getLiveChatState(sessionId: string): Promise<LiveChatState | null> {
  return invoke<LiveChatState | null>("chat_live_state", { sessionId });
}

/** 一个子代理运行记录（后端 AgentRun 事件）。 */
export interface AgentRunStat {
  agent: string;
  ok: boolean;
  durationMs: number;
  steps: number;
  /** 该子代理自己的 token 用量（可能缺省）。 */
  usage?: TokenUsage | null;
}

/** Stream frames emitted during one turn. */
export type ChatEvent =
  | { type: "step"; step: number; action: string; query: string }
  | { type: "subStep"; step: number; agent: string; action: string; query: string }
  | ({ type: "agentRun" } & AgentRunStat)
  | {
      type: "plan";
      version: number;
      steps: { desc: string; status: string; note: string }[];
    }
  | { type: "chunk"; content: string }
  | { type: "sources"; sources: ChatSource[] }
  | { type: "interact"; interact: ChatInteraction }
  | { type: "artifact"; artifacts: ChatArtifact[] }
  /** 本轮 token 用量（提供方未上报时不发）。 */
  | { type: "usage"; usage: TokenUsage }
  | { type: "title"; title: string }
  | { type: "done"; msgId: string }
  | { type: "error"; message: string };

/** Final outcome of one completed turn. */
export interface ChatTurnResult {
  msgId: string;
  answer: string;
  /** 本轮聚合 token 用量；null = 提供方未上报。 */
  usage?: TokenUsage | null;
}

/** List active conversations, most recently updated first. */
export function listSessions(): Promise<ChatSessionRow[]> {
  return invoke<ChatSessionRow[]>("chat_sessions_list");
}

/** 对话工作模式：普通对话 / 简历制作 / PPT 制作。 */
export type ChatMode = "chat" | "resume" | "slides";

/** 各模式会话标题的固定后缀（也是历史列表的过滤标记）。 */
export const MODE_SUFFIX: Record<Exclude<ChatMode, "chat">, string> = {
  resume: "——简历",
  slides: "——PPT",
};

export const CHAT_MODE_STORAGE_KEY = "mb.chat.mode";
/** 薄入口页跳进聊天时一次性指定模式的 sessionStorage 键。 */
export const CHAT_MODE_JUMP_KEY = "mb-chat-mode";

/** 规范化不可信的模式值。 */
export function normalizeChatMode(value: string | null): ChatMode {
  return value === "resume" || value === "slides" ? value : "chat";
}

/** 首条消息 → 会话标题前缀（压缩空白、截 24 字）。 */
export function chatTitlePrefix(question: string): string {
  const squeezed = question.trim().replace(/\s+/g, " ");
  if (squeezed === "") return "新对话";
  return squeezed.length > 24 ? `${squeezed.slice(0, 24)}…` : squeezed;
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
  /**
   * 用户主动附带的图片（data URL；最多 4 张、单张 ≤5MB、合计 ≤15MB）。
   * 只随本轮请求发送、不落库：后端仅把它作为本轮上下文的一条 user 消息，
   * 刷新 / 切会话后历史只重放文本。
   */
  images: string[] = [],
  /** 当前科研项目 id：非空时后端把项目简报注入本轮 system 上下文。 */
  researchProjectId: string | null = null,
  /** true = 重新生成：替换最后一条助手消息，不重复写入用户问题。 */
  regenerate = false,
): Promise<ChatTurnResult> {
  const channel = new Channel<ChatEvent>();
  channel.onmessage = onEvent;
  return invoke<ChatTurnResult>("chat_ask", {
    sessionId,
    question,
    provider,
    skill,
    // 不传图片时显式 null，对应 Rust 侧的 Option<Vec<String>>（None）。
    images: images.length > 0 ? images : null,
    researchProjectId,
    regenerate,
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
