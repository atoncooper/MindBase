import { generateText, streamText } from "ai";
import { aiTelemetry } from "../llm/tracing.js";
import { createGatewayModel } from "../llm/provider.js";
import { createLogger } from "../logger.js";
import type { PromptRegistry } from "../agent/prompts/loader.js";
import type { ChatMessage, ChatSession, ChatSessionRepository, MessageRepository } from "../repository/persistence.js";
import type { SessionSummaryDoc, SessionSummaryRepository } from "../repository/session-summaries.js";

const log = createLogger("SESSION_SUMMARY");

/**
 * Session summary service — port of app/services/session_summary.py +
 * app/agent/summary/* (single-LLM-call summarization, no tools).
 *
 * - prepare(): ownership / non-empty checks BEFORE the SSE response starts, so
 *   failures surface as real HTTP status codes (404 / 400) instead of a broken
 *   stream (Python prepare_summary parity).
 * - streamFrames(): pure SSE generator (chunk / done / error); accumulates the
 *   streamed tokens and persists the finished summary.
 * - latest(): newest persisted summary (404 when none yet).
 *
 * Storage is app-ts's own (Mongo mind_base_ts.session_summaries); the summary
 * never enters the conversation it summarizes.
 */

export const DEFAULT_QUERY = "请总结当前会话";
export const FALLBACK_RESULT = "总结服务暂时不可用，请稍后再试。";
export const EMPTY_RESULT = "该会话没有可总结的对话内容。";

/** Same cap as the Python summary agent (larger sessions summarize the most recent slice). */
const MAX_HISTORY_MESSAGES = 500;

export class SessionSummaryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SessionSummaryError";
  }
}

export interface SummaryFrame {
  type: "chunk" | "done" | "error";
  content?: string;
  message?: string;
  summary_id?: string | null;
  message_count?: number;
}

export interface PreparedSummary {
  history: ChatMessage[];
  system: string;
  prompt: string;
}

export interface SessionSummaryWire {
  summary_id: string;
  chat_session_id: string;
  content: string;
  message_count: number;
  first_message_at: string | null;
  last_message_at: string | null;
  created_at: string | null;
}

/** Injectable streaming LLM call (tests supply a stub; default = AI SDK streamText via the gateway). */
export type SummaryStreamFn = (args: {
  system: string;
  prompt: string;
  uid: string;
  sessionId: string;
}) => AsyncIterable<string>;

const defaultStream: SummaryStreamFn = (args) =>
  streamText({
    model: createGatewayModel("session_summary", { uid: args.uid, temperature: 0.3 }),
    system: args.system,
    prompt: args.prompt,
    ...aiTelemetry("session.summary"),
    abortSignal: AbortSignal.timeout(120_000),
  }).textStream;

export class SessionSummaryService {
  constructor(
    private readonly sessions: ChatSessionRepository,
    private readonly messages: MessageRepository,
    private readonly repo: SessionSummaryRepository,
    private readonly prompts: PromptRegistry,
    private readonly stream: SummaryStreamFn = defaultStream,
  ) {}

  /** Session ownership + non-empty guard (shared by the summary button and the
   * quiz-from-summary flow). Returns the session so callers can derive a title. */
  async ensureSession(uid: string, chatSessionId: string, emptyMessage = "会话暂无消息，无法总结"): Promise<ChatSession> {
    const session = await this.sessions.get(chatSessionId, uid);
    if (!session) throw new SessionSummaryError(404, "会话不存在");
    if ((await this.messages.countBySession(chatSessionId)) === 0) {
      throw new SessionSummaryError(400, emptyMessage);
    }
    return session;
  }

  /**
   * Latest summary content, generating one (non-streaming) when absent — the
   * non-streaming counterpart used by quiz-from-summary
   * (Python get_or_create_summary parity: both features share one summary).
   */
  async getOrCreateContent(uid: string, chatSessionId: string): Promise<string> {
    await this.ensureSession(uid, chatSessionId);
    const existing = await this.repo.latest(chatSessionId, uid);
    if (existing && existing.content.trim()) return existing.content;

    const prepared = await this.prepare(uid, chatSessionId);
    const { text } = await generateText({
      model: createGatewayModel("session_summary", { uid, temperature: 0.3 }),
      system: prepared.system,
      prompt: prepared.prompt,
      ...aiTelemetry("session.summary"),
      abortSignal: AbortSignal.timeout(120_000),
    });
    const content = text.trim();
    if (!content) throw new SessionSummaryError(502, "会话总结生成失败，请稍后重试");

    const first = prepared.history[0];
    const last = prepared.history[prepared.history.length - 1];
    try {
      await this.repo.insert({
        chatSessionId,
        uid,
        content,
        messageCount: prepared.history.length,
        firstMessageAt: first ? first.createdAt : null,
        lastMessageAt: last ? last.createdAt : null,
      });
    } catch (err) {
      // The content itself is usable; persistence failure must not abort the caller.
      log.error(
        "[SESSION_SUMMARY] persist (non-stream) failed session=" + chatSessionId.slice(0, 8) + ": " +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    return content;
  }

  /** Latest persisted summary; 404 for both unknown session and no-summary-yet. */
  async latest(uid: string, chatSessionId: string): Promise<SessionSummaryDoc> {
    const session = await this.sessions.get(chatSessionId, uid);
    if (!session) throw new SessionSummaryError(404, "会话不存在");
    const doc = await this.repo.latest(chatSessionId, uid);
    if (!doc) throw new SessionSummaryError(404, "该会话暂无总结");
    return doc;
  }

  /** Validate + build the prompt before the SSE response begins. */
  async prepare(uid: string, chatSessionId: string): Promise<PreparedSummary> {
    const session = await this.sessions.get(chatSessionId, uid);
    if (!session) throw new SessionSummaryError(404, "会话不存在");
    if ((await this.messages.countBySession(chatSessionId)) === 0) {
      throw new SessionSummaryError(400, "会话暂无消息，无法总结");
    }
    const history = await this.messages.recentMessages(chatSessionId, MAX_HISTORY_MESSAGES);
    const transcript = history
      .map((m) => "【" + (m.role === "user" ? "用户" : "助手") + "】\n" + m.content.trim())
      .join("\n\n");
    return {
      history,
      system: this.prompts.render("agents/summary", {}),
      prompt: DEFAULT_QUERY + "\n\n<conversation>\n" + transcript + "\n</conversation>",
    };
  }

  /** SSE frames; never throws after the stream started (persist failures degrade to a done frame). */
  async *streamFrames(
    uid: string,
    chatSessionId: string,
    prepared: PreparedSummary,
  ): AsyncGenerator<SummaryFrame> {
    let accumulated = "";
    try {
      for await (const delta of this.stream({
        system: prepared.system,
        prompt: prepared.prompt,
        uid,
        sessionId: chatSessionId,
      })) {
        if (!delta) continue;
        accumulated += delta;
        yield { type: "chunk", content: delta };
      }
    } catch (err) {
      log.error(
        "[SESSION_SUMMARY] stream failed session=" + chatSessionId.slice(0, 8) + ": " +
          (err instanceof Error ? err.message : String(err)),
      );
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    if (!accumulated.trim()) {
      // No tokens streamed (LLM produced nothing) — report instead of persisting an empty summary.
      yield { type: "error", message: EMPTY_RESULT };
      return;
    }

    const first = prepared.history[0];
    const last = prepared.history[prepared.history.length - 1];
    const messageCount = prepared.history.length;
    try {
      const saved = await this.repo.insert({
        chatSessionId,
        uid,
        content: accumulated.trim(),
        messageCount,
        firstMessageAt: first ? first.createdAt : null,
        lastMessageAt: last ? last.createdAt : null,
      });
      yield { type: "done", summary_id: saved.summaryId, message_count: messageCount };
    } catch (err) {
      // The summary itself reached the user; persistence failure must not discard it.
      log.error(
        "[SESSION_SUMMARY] persist failed session=" + chatSessionId.slice(0, 8) + ": " +
          (err instanceof Error ? err.message : String(err)),
      );
      yield { type: "done", summary_id: null, message_count: messageCount };
    }
  }

  /** snake_case wire shape (frontend snakeToCamel); timestamps in Python's naive-UTC ISO form. */
  toWire(doc: SessionSummaryDoc): SessionSummaryWire {
    return {
      summary_id: doc.summaryId,
      chat_session_id: doc.chatSessionId,
      content: doc.content,
      message_count: doc.messageCount,
      first_message_at: iso(doc.firstMessageAt),
      last_message_at: iso(doc.lastMessageAt),
      created_at: iso(doc.createdAt),
    };
  }
}

/** Naive-UTC ISO (no zone suffix) — same as services/chat-sessions.ts. */
function iso(epoch: number | null | undefined): string | null {
  if (epoch === undefined || epoch === null) return null;
  return new Date(epoch).toISOString().replace(/\.(\d{3})Z$/, ".$1");
}
