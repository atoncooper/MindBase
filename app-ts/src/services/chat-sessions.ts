import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import type { ChatMessage, ChatSession, ChatSessionRepository, MessageRepository } from "../repository/persistence.js";
import type { ChatImageStorage } from "../repository/chat-images.js";
import type { SessionDocumentRepository } from "../repository/session-docs.js";
import type { Source } from "../context/types.js";

const log = createLogger("CHAT_SESSIONS");

/**
 * Chat sessions/history REST service — a wire-contract port of the Python
 * /chat/sessions + /chat/history surface (app/routers/chat.py +
 * services/chat_history.py) so frontendv2's chatApi works unchanged after the
 * chat-domain cutover to app-ts.
 *
 * Contract notes (Python parity):
 * - wire fields are snake_case; message status "done" maps to "completed"
 * - ownership scoping (chat_session_id, uid): not-owned == nonexistent (404)
 * - session list hides empty sessions older than a 5-minute grace window
 *   (auto-created sessions that never received a message must not litter)
 * - DELETE /chat/history/from/{msg_id} truncates the anchor and everything
 *   after it (regenerate flow); anchor missing → 404 消息不存在
 */

/**
 * Sessions without any message older than this are hidden from the list and
 * self-cleaned. The app no longer creates sessions before the first message, so
 * this is a backstop for legacy/foreign clients (a session whose only content is
 * uploaded documents is never treated as empty).
 */
const EMPTY_SESSION_GRACE_MS = 5 * 60 * 1000;

export class ChatSessionsError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface WireSession {
  chat_session_id: string;
  title: string | null;
  status: string;
  created_at: string | null;
  updated_at: string | null;
  last_message_at: string | null;
  /** 绑定的科研项目 id（新建会话时可选绑定）；null = 普通对话 */
  academic_project_id: string | null;
}

export interface WireMessage {
  msg_id: string;
  chat_session_id: string;
  role: string;
  content: string;
  status: "completed" | "failed";
  sources?: Source[];
  /** structured UI artifacts (plot / diagram / quiz / ...) persisted with the turn */
  artifacts?: import("../context/types.js").Artifact[];
  /** attached images: presigned MinIO URLs (durable) or legacy inline data URLs */
  images?: string[];
  tokens_used?: number;
  error?: string;
  created_at: string | null;
}

export interface HistoryPage {
  messages: WireMessage[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

export class ChatSessionsService {
  private readonly emptyGraceMs: number;

  private readonly chatImages?: ChatImageStorage;
  private readonly sessionDocs?: SessionDocumentRepository;

  constructor(
    private readonly sessions: ChatSessionRepository,
    private readonly messages: MessageRepository,
    opts: { emptyGraceMs?: number; chatImages?: ChatImageStorage; sessionDocs?: SessionDocumentRepository } = {},
  ) {
    this.emptyGraceMs = opts.emptyGraceMs ?? EMPTY_SESSION_GRACE_MS;
    this.chatImages = opts.chatImages;
    this.sessionDocs = opts.sessionDocs;
  }

  /**
   * Creates a session, optionally bound to a research project. The binding is
   * persisted on the session row so reopening it later (sidebar history, "在对话
   * 中继续") keeps the project context; the id is sanitized at the HTTP layer
   * and project ownership is still enforced per turn by the academic resolver.
   */
  async create(uid: string, title?: string, academicProjectId?: string): Promise<WireSession> {
    const sessionId = randomUUID();
    const session = await this.sessions.getOrCreate(sessionId, uid);
    if (title) await this.sessions.rename(sessionId, title);
    if (academicProjectId) await this.sessions.setAcademicProject(sessionId, academicProjectId);
    return toWireSession({
      ...session,
      ...(title ? { title } : {}),
      ...(academicProjectId ? { academicProjectId } : {}),
    });
  }

  /** List + hide empty sessions past the grace window (Python list_sessions
   * cleanup parity). Hard-deletes the hidden rows so the store self-cleans. */
  async list(uid: string): Promise<WireSession[]> {
    const rows = await this.sessions.list(uid);
    const out: WireSession[] = [];
    for (const s of rows) {
      const hasMessages = (await this.messages.countBySession(s.id)) > 0;
      if (!hasMessages && Date.now() - s.createdAt > this.emptyGraceMs) {
        // Uploaded session documents are real content: a session whose only
        // payload is uploaded files must not be swept away as "empty".
        const docs = this.sessionDocs ? await this.sessionDocs.list(s.id).catch(() => []) : [];
        if (docs.length === 0) {
          await this.sessions.delete(s.id, uid);
          continue;
        }
      }
      out.push(toWireSession(s));
    }
    return out;
  }

  async get(uid: string, sessionId: string): Promise<WireSession> {
    const session = await this.sessions.get(sessionId, uid);
    if (!session) throw new ChatSessionsError(404, "会话不存在");
    return toWireSession(session);
  }

  async rename(uid: string, sessionId: string, title: string): Promise<WireSession> {
    if (!title || title.trim() === "") {
      throw new ChatSessionsError(400, "标题不能为空");
    }
    const session = await this.sessions.get(sessionId, uid);
    if (!session) throw new ChatSessionsError(404, "会话不存在");
    await this.sessions.rename(sessionId, title.trim());
    const updated = await this.sessions.get(sessionId, uid);
    return toWireSession(updated ?? session);
  }

  async delete(uid: string, sessionId: string): Promise<{ success: true }> {
    const session = await this.sessions.get(sessionId, uid);
    if (!session) throw new ChatSessionsError(404, "会话不存在");
    // MinIO 对象先收集后删:文档附件(chat-files/*)+ 消息附图(chat-images/*)
    const objectKeys: string[] = [];
    if (this.sessionDocs) {
      const docs = await this.sessionDocs.list(sessionId);
      objectKeys.push(...docs.map((d) => d.key).filter((k): k is string => Boolean(k)));
    }
    const msgs = await this.messages.listBySession(sessionId);
    for (const m of msgs) {
      for (const r of m.imageRefs ?? []) if (r.key) objectKeys.push(r.key);
    }
    await this.messages.deleteBySession(sessionId);
    if (this.sessionDocs) await this.sessionDocs.deleteBySession(sessionId);
    if (this.chatImages?.durable && objectKeys.length > 0) {
      await Promise.allSettled(objectKeys.map((k) => this.chatImages!.remove(k)));
    }
    await this.sessions.delete(sessionId, uid);
    return { success: true };
  }

  async history(uid: string, sessionId: string, page: number, pageSize: number): Promise<HistoryPage> {
    const session = await this.sessions.get(sessionId, uid);
    if (!session) throw new ChatSessionsError(404, "会话不存在");
    const all = await this.messages.listBySession(sessionId);
    const total = all.length;
    const start = (page - 1) * pageSize;
    const slice = all.slice(start, start + pageSize);
    return {
      messages: await Promise.all(slice.map((m) => this.toWire(m, sessionId))),
      total,
      page,
      page_size: pageSize,
      has_more: page * pageSize < total,
    };
  }

  /** Wire mapping + image display URLs: durable refs → presigned GETs (fresh on
   * every history fetch); legacy messages keep their inline data URLs. */
  private async toWire(m: ChatMessage, sessionId: string): Promise<WireMessage> {
    const wire = toWireMessage(m, sessionId);
    if (m.imageRefs?.length && this.chatImages) {
      wire.images = await Promise.all(
        m.imageRefs.map((r) => this.chatImages!.presignGet(r.key, 7 * 24 * 3600)),
      );
    } else if (m.images?.length) {
      wire.images = m.images;
    }
    return wire;
  }

  async clearHistory(uid: string, sessionId: string): Promise<{ success: true }> {
    const session = await this.sessions.get(sessionId, uid);
    if (!session) throw new ChatSessionsError(404, "会话不存在");
    await this.messages.deleteBySession(sessionId);
    return { success: true };
  }

  /** Truncate at the anchor (inclusive) — regenerate flow. */
  async truncateFrom(
    uid: string,
    sessionId: string,
    msgId: string,
  ): Promise<{ success: true; deleted: number }> {
    const session = await this.sessions.get(sessionId, uid);
    if (!session) throw new ChatSessionsError(404, "会话不存在");
    const deleted = await this.messages.truncateFrom(sessionId, msgId);
    if (deleted === undefined) throw new ChatSessionsError(404, "消息不存在");
    return { success: true, deleted };
  }
}

function toWireSession(s: ChatSession): WireSession {
  return {
    chat_session_id: s.id,
    title: s.title ?? null,
    status: "active",
    created_at: iso(s.createdAt),
    updated_at: iso(s.updatedAt),
    last_message_at: iso(s.lastMessageAt),
    academic_project_id: s.academicProjectId ?? null,
  };
}

function toWireMessage(m: ChatMessage, sessionId: string): WireMessage {
  const wire: WireMessage = {
    msg_id: m.id,
    chat_session_id: sessionId,
    role: m.role,
    content: m.content,
    status: m.status === "failed" ? "failed" : "completed",
    created_at: iso(m.createdAt),
  };
  if (m.sources && m.sources.length > 0) wire.sources = m.sources.slice(0, 5);
  if (m.artifacts && m.artifacts.length > 0) wire.artifacts = m.artifacts;
  if (m.usage?.totalTokens !== undefined) wire.tokens_used = m.usage.totalTokens;
  if (m.error) wire.error = m.error;
  return wire;
}

/** Naive-UTC ISO (no zone suffix) — matches how the Python backend serialized
 * its naive-UTC datetimes, so the frontend parses both identically. */
function iso(epoch: number | undefined): string | null {
  if (epoch === undefined) return null;
  return new Date(epoch).toISOString().replace(/\.(\d{3})Z$/, ".$1");
}
