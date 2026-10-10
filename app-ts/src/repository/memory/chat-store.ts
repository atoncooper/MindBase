import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ChatSessionRepository,
  ConversationSummary,
  MessageRepository,
} from "../persistence.js";
import type { ChatSession } from "../persistence.js";
import type { Source } from "../../context/types.js";

/** In-memory implementation: for v1 integration testing; interfaces unchanged, MySQL adapters replace these later. */
export class MemoryChatSessionRepository implements ChatSessionRepository {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly summaries = new Map<string, ConversationSummary>();

  async getOrCreate(sessionId: string, uid?: string): Promise<ChatSession> {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { id: sessionId, uid, createdAt: Date.now(), updatedAt: Date.now() };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  async get(sessionId: string, uid?: string): Promise<ChatSession | undefined> {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    if (uid !== undefined && s.uid !== uid) return undefined;
    return s;
  }

  async touch(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.updatedAt = Date.now();
      s.lastMessageAt = Date.now();
    }
  }

  async rename(sessionId: string, title: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) s.title = title;
  }

  async list(uid?: string): Promise<ChatSession[]> {
    return [...this.sessions.values()]
      .filter((s) => uid === undefined || s.uid === uid)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async delete(sessionId: string, uid?: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s || (uid !== undefined && s.uid !== uid)) return false;
    return this.sessions.delete(sessionId);
  }

  async getSummary(sessionId: string): Promise<ConversationSummary | undefined> {
    return this.summaries.get(sessionId);
  }

  async saveSummary(sessionId: string, summary: ConversationSummary): Promise<void> {
    this.summaries.set(sessionId, summary);
  }
}

export class MemoryMessageRepository implements MessageRepository {
  private readonly messages = new Map<string, ChatMessage>();
  /** strictly-increasing clock: same-ms inserts must stay ordered (truncateFrom semantics) */
  private lastTs = 0;

  private now(): number {
    const t = Math.max(Date.now(), this.lastTs + 1);
    this.lastTs = t;
    return t;
  }

  async beginTurn(sessionId: string, userMessage: string, images?: string[], imageRefs?: import("../persistence.js").StoredChatImage[]) {
    const userMsg: ChatMessage = {
      id: randomUUID(),
      sessionId,
      role: "user",
      content: userMessage,
      images,
      imageRefs,
      status: "done",
      createdAt: this.now(),
    };
    const assistantMsg: ChatMessage = {
      id: randomUUID(),
      sessionId,
      role: "assistant",
      content: "",
      status: "pending",
      createdAt: this.now(),
    };
    this.messages.set(userMsg.id, userMsg);
    this.messages.set(assistantMsg.id, assistantMsg);
    return { userMsg, assistantMsg };
  }

  async appendChunk(assistantMsgId: string, delta: string): Promise<void> {
    const m = this.messages.get(assistantMsgId);
    if (m) m.content += delta;
  }

  async resetContent(assistantMsgId: string): Promise<void> {
    const m = this.messages.get(assistantMsgId);
    if (m) m.content = "";
  }

  async finalizeTurn(
    assistantMsgId: string,
    patch: {
      sources?: Source[];
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      status: "done" | "failed";
      error?: string;
    },
  ): Promise<void> {
    const m = this.messages.get(assistantMsgId);
    if (!m) return;
    if (patch.sources) m.sources = patch.sources;
    if (patch.usage) m.usage = patch.usage;
    if (patch.error) m.error = patch.error;
    m.status = patch.status;
  }

  async recentMessages(sessionId: string, limit: number): Promise<ChatMessage[]> {
    const all = [...this.messages.values()]
      .filter((m) => m.sessionId === sessionId && m.status === "done")
      .sort((a, b) => a.createdAt - b.createdAt);
    return all.slice(-limit);
  }

  async getMessage(messageId: string): Promise<ChatMessage | undefined> {
    return this.messages.get(messageId);
  }

  private doneIn(sessionId: string): ChatMessage[] {
    return [...this.messages.values()]
      .filter((m) => m.sessionId === sessionId && m.status === "done")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async countDone(sessionId: string): Promise<number> {
    return this.doneIn(sessionId).length;
  }

  async listDone(sessionId: string, skip: number, limit: number): Promise<ChatMessage[]> {
    return this.doneIn(sessionId).slice(skip, skip + limit);
  }

  async listBySession(sessionId: string): Promise<ChatMessage[]> {
    return [...this.messages.values()]
      .filter((m) => m.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async countBySession(sessionId: string): Promise<number> {
    return [...this.messages.values()].filter((m) => m.sessionId === sessionId).length;
  }

  async deleteBySession(sessionId: string): Promise<number> {
    let deleted = 0;
    for (const [id, m] of [...this.messages.entries()]) {
      if (m.sessionId === sessionId) {
        this.messages.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  async truncateFrom(sessionId: string, anchorMsgId: string): Promise<number | undefined> {
    const anchor = this.messages.get(anchorMsgId);
    if (!anchor || anchor.sessionId !== sessionId) return undefined;
    let deleted = 0;
    for (const [id, m] of [...this.messages.entries()]) {
      if (m.sessionId === sessionId && m.createdAt >= anchor.createdAt) {
        this.messages.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }
}
