/**
 * Chat persistence contracts (repository layer): interfaces here, in-memory
 * implementations under memory/ and the MongoDB adapter under mongo/. Minimal
 * data surface required by the Turn lifecycle of Python services/chat/lifecycle.py.
 */
export interface ChatSession {
  id: string;
  uid?: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  /** bumped whenever a message lands in the session (Python last_message_at) */
  lastMessageAt?: number;
}

export type MessageRole = "user" | "assistant";

/** Durable image attachment: an object under the chat-images/ MinIO prefix.
 * Display goes through presigned GET URLs; model-context hydration reads the
 * object back as a data URL (remote providers cannot reach local MinIO). */
export interface StoredChatImage {
  key: string;
  contentType: string;
  sizeBytes: number;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  sources?: import("../context/types.js").Source[];
  /** token usage captured from the LLM finish frame */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** pending placeholder (while the assistant message is streaming) */
  status: "pending" | "done" | "failed";
  /** assistant generation error text when status = failed */
  error?: string;
  /** multimodal user messages: attached images for display (presigned URLs on
   * MinIO-backed messages; legacy inline data URLs otherwise) */
  images?: string[];
  /** durable image attachments (MinIO chat-images/*); hydrated to `images` by callers */
  imageRefs?: StoredChatImage[];
  createdAt: number;
}

/** Rolling compressed summary of a conversation (context compression, mirrors Python Redis summary). */
export interface ConversationSummary {
  summary: string;
  /** number of done messages already covered by the summary (they are excluded from recompression) */
  summarizedCount: number;
  updatedAt: number;
}

export interface ChatSessionRepository {
  getOrCreate(sessionId: string, uid?: string): Promise<ChatSession>;
  /** undefined when the session does not exist (no implicit create) */
  get(sessionId: string, uid?: string): Promise<ChatSession | undefined>;
  touch(sessionId: string): Promise<void>;
  rename(sessionId: string, title: string): Promise<void>;
  list(uid?: string): Promise<ChatSession[]>;
  /** hard-delete the session row (messages are deleted separately) */
  delete(sessionId: string, uid?: string): Promise<boolean>;
  getSummary(sessionId: string): Promise<ConversationSummary | undefined>;
  saveSummary(sessionId: string, summary: ConversationSummary): Promise<void>;
}

export interface MessageRepository {
  beginTurn(
    sessionId: string,
    userMessage: string,
    /** inline data URLs (legacy fallback when image storage is non-durable) */
    images?: string[],
    /** durable MinIO refs — stored INSTEAD of the data URLs when provided */
    imageRefs?: StoredChatImage[],
  ): Promise<{ userMsg: ChatMessage; assistantMsg: ChatMessage }>;
  appendChunk(assistantMsgId: string, delta: string): Promise<void>;
  /** clear streamed content after a `reset` frame (retry restarts from scratch) */
  resetContent(assistantMsgId: string): Promise<void>;
  finalizeTurn(
    assistantMsgId: string,
    patch: {
      sources?: import("../context/types.js").Source[];
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      status: "done" | "failed";
      /** generation error text when status = failed */
      error?: string;
    },
  ): Promise<void>;
  recentMessages(sessionId: string, limit: number): Promise<ChatMessage[]>;
  getMessage(messageId: string): Promise<ChatMessage | undefined>;
  /** total count of done messages in the session (for compression threshold checks) */
  countDone(sessionId: string): Promise<number>;
  /** done messages in createdAt order with offset pagination (older-than-recent-window slice) */
  listDone(sessionId: string, skip: number, limit: number): Promise<ChatMessage[]>;
  /** ALL messages of the session (any status) in createdAt order — history reads */
  listBySession(sessionId: string): Promise<ChatMessage[]>;
  /** total message count of the session (any status) */
  countBySession(sessionId: string): Promise<number>;
  /** hard-delete every message of the session; returns the deleted count */
  deleteBySession(sessionId: string): Promise<number>;
  /** delete the anchor message and everything after it (regenerate flow);
   * returns undefined when the anchor msg does not exist in the session */
  truncateFrom(sessionId: string, anchorMsgId: string): Promise<number | undefined>;
}
