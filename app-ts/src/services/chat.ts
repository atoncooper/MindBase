import { randomUUID } from "node:crypto";
import type { AgentHarness } from "../harness/app.js";
import type { ChatSessionRepository, ChatMessage, MessageRepository, StoredChatImage } from "../repository/persistence.js";
import type { ChatImageStorage } from "../repository/chat-images.js";
import type { SseFrame } from "../transport/sse.js";
import type { SearchScope, Source } from "../context/types.js";
import type { ContextCompressionService } from "./context-compression.js";
import {
  AdmissionTicket,
  QueueFullError,
  QueueTimeoutError,
  WeightedAdmissionQueue,
  getAdmissionQueue,
} from "./admission.js";
import { resolveTier } from "../utils/membership.js";
import { config } from "../config/index.js";
import { createLogger } from "../logger.js";

/**
 * Endpoint-level orchestration (mirrors Python services/chat/orchestrator.py):
 * begin_turn → weighted admission (scheduling.*) → harness.dispatchStream →
 * finalize/fail_turn. Frame passthrough + accumulating assistant message
 * content and persisting it. Also owns: reset handling (retry), usage capture,
 * title scheduling, scope inheritance.
 */
export interface AskStreamRequest {
  query: string;
  uid?: string;
  sessionId?: string;
  agentName?: string;
  scope?: SearchScope;
  historyLimit?: number;
  /** attached images (data URLs, vision-gated at the HTTP layer) */
  images?: string[];
  /** user-selected installed skills forced into the system prompt */
  skillIds?: string[];
}

const log = createLogger("CHAT");

/**
 * Scope inheritance (mirrors Python dispatcher): with no explicit scope, reuse the
 * bvids from the most recent assistant message's sources — "keep asking about the
 * same video" keeps working across turns.
 */
export function inheritScopeFromHistory(history: ChatMessage[]): SearchScope {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "assistant" || !m.sources?.length) continue;
    const bvids = [...new Set(m.sources.map((s) => s.bvid).filter((b): b is string => Boolean(b)))];
    if (bvids.length > 0) return { bvids };
  }
  return {};
}

function scopeIsEmpty(scope: SearchScope | undefined): boolean {
  return !scope || (!scope.bvids?.length && !scope.uploadUuids?.length && !scope.mediaIds?.length);
}

export class ChatService {
  constructor(
    private readonly harness: AgentHarness,
    private readonly sessions: ChatSessionRepository,
    private readonly messages: MessageRepository,
    private readonly compression?: ContextCompressionService,
    /** fire-and-forget title generation for the session's first turn */
    private readonly titleGen?: (sessionId: string, firstQuery: string) => void,
    /** turn-level admission queue; undefined → process singleton, null → disabled */
    private readonly admission?: WeightedAdmissionQueue | null,
    /** durable image attachments (MinIO); undefined → inline data URLs (legacy) */
    private readonly chatImages?: ChatImageStorage,
  ) {}

  private get admissionQueue(): WeightedAdmissionQueue | null {
    return this.admission === undefined ? getAdmissionQueue() : this.admission;
  }

  async *askStream(req: AskStreamRequest): AsyncGenerator<SseFrame> {
    const sessionId = req.sessionId ?? randomUUID();
    const session = await this.sessions.getOrCreate(sessionId, req.uid);
    const stored = req.images?.length ? await this.storeImages(session.id, req.images) : undefined;
    const { assistantMsg } = await this.messages.beginTurn(session.id, req.query, stored?.inlineImages, stored?.refs);

    const history = await this.hydrateHistoryImages(
      await this.messages.recentMessages(session.id, req.historyLimit ?? config.context.recentKeep),
    );
    const effectiveScope = scopeIsEmpty(req.scope) ? inheritScopeFromHistory(history) : (req.scope ?? {});
    if (scopeIsEmpty(req.scope) && !scopeIsEmpty(effectiveScope)) {
      log.info(`[CHAT] scope inherited from previous sources session=${sessionId}`);
    }

    let fullContent = "";
    let finalSources: Source[] = [];
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    let hadError = false;

    const admission = this.admissionQueue;
    let ticket: AdmissionTicket | null = null;
    try {
      if (admission) {
        // weighted admission: under the cap this is a no-op; at capacity the
        // turn queues (queue progress frames) or throws (full/timeout)
        ticket = yield* this.admitTurn(admission, sessionId, req.uid);
      }

      for await (const frame of this.harness.dispatchStream({
        sessionId: session.id,
        query: req.query,
        uid: req.uid,
        scope: effectiveScope,
        history: history.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.images?.length ? { images: m.images } : {}),
        })),
        agentName: req.agentName,
        skillIds: req.skillIds,
      })) {
        if (frame.type === "chunk") {
          fullContent += frame.content;
          await this.messages.appendChunk(assistantMsg.id, frame.content);
        } else if (frame.type === "sources") {
          finalSources = frame.sources;
        } else if (frame.type === "error") {
          hadError = true;
        } else if (frame.type === "reset") {
          // retried attempt streams fresh: clear accumulated content on both sides
          fullContent = "";
          await this.messages.resetContent(assistantMsg.id);
          yield frame;
        } else if (frame.type === "usage") {
          usage = frame.usage; // internal frame: consumed here, never forwarded
          continue;
        }
        yield frame;
      }
      await this.messages.finalizeTurn(assistantMsg.id, {
        sources: finalSources,
        usage,
        status: hadError ? "failed" : "done",
      });
      if (usage && (usage.totalTokens || usage.outputTokens)) {
        log.info(`[CHAT] turn usage session=${sessionId} in=${usage.inputTokens ?? "?"} out=${usage.outputTokens ?? "?"} total=${usage.totalTokens ?? "?"}`);
      }
      await this.sessions.touch(session.id);
      if (!hadError) {
        this.compression?.schedule(session.id);
        // first turn of a session → generate the title in the background
        if (!session.title) this.titleGen?.(session.id, req.query);
      }
    } catch (err) {
      await this.messages.finalizeTurn(assistantMsg.id, { status: "failed" });
      if (err instanceof QueueFullError) {
        // fail fast on an overloaded system — never entered the queue
        log.warn(`[CHAT] admission queue full session=${sessionId} uid=${req.uid ?? "-"}`);
        yield { type: "error", message: "当前使用人数较多，请稍后重试" };
        yield { type: "done" };
        return;
      }
      if (err instanceof QueueTimeoutError) {
        log.warn(`[CHAT] admission queue timeout session=${sessionId} uid=${req.uid ?? "-"} waited=${err.waitedMs}ms`);
        yield { type: "error", message: "当前使用人数较多，排队超时，请稍后重试" };
        yield { type: "done" };
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[CHAT] turn failed session=${sessionId}: ${message}`);
      yield { type: "error", message };
      yield { type: "done" };
    } finally {
      // `ticket` is non-null only once granted (admitTurn cleans up its own
      // queued ticket on every unwinding path, including disconnect).
      if (admission && ticket) {
        if (ticket.acquired) admission.release(ticket);
        else admission.cancel(ticket); // defensive; unreachable today
      }
    }
  }

  /**
   * Persist turn attachments: durable MinIO refs when storage is available and
   * every image uploaded; otherwise fall back to inline data URLs (the legacy
   * doc shape — also what non-configured deployments keep doing).
   */
  private async storeImages(
    sessionId: string,
    images: string[],
  ): Promise<{ refs?: StoredChatImage[]; inlineImages?: string[] }> {
    const storage = this.chatImages;
    if (!storage) return { inlineImages: images };
    const settled = await Promise.allSettled(images.map((img) => storage.put(sessionId, img)));
    const refs = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    if (storage.durable && refs.length === images.length) return { refs };
    log.warn(
      `[CHAT] image storage fallback to inline data urls (durable=${storage.durable}, ok=${refs.length}/${images.length})`,
    );
    return { inlineImages: images };
  }

  /**
   * Later turns re-attach previous images as model context. MinIO-backed docs
   * keep only refs, so read them back as data URLs here (a remote LLM provider
   * cannot fetch a local MinIO). Legacy docs already carry inline data URLs.
   */
  private async hydrateHistoryImages(history: ChatMessage[]): Promise<ChatMessage[]> {
    if (!this.chatImages) return history;
    return Promise.all(
      history.map(async (m) => {
        if (!m.imageRefs?.length || m.images?.length) return m;
        const urls = await Promise.all(m.imageRefs.map((r) => this.chatImages!.getDataUrl(r.key)));
        const ok = urls.every((u): u is string => Boolean(u));
        return ok ? { ...m, images: urls } : m;
      }),
    );
  }

  /**
   * Acquire an execution slot for this turn (weighted admission, uid → tier
   * via services/membership.ts). Grants immediately under the cap; otherwise
   * queues, emitting `queue` progress frames until granted. Throws
   * QueueFullError / QueueTimeoutError — handled by the askStream catch
   * (persist failed + friendly error frame), so this helper never touches
   * persistence or terminal frames itself.
   *
   * Owns its ticket until it returns one: the finally cancels a still-queued
   * ticket on ANY unwinding — including a generator `.return()` when the
   * client disconnects mid-queue. On the return path askStream's
   * `ticket = yield*` assignment never happens, so the cleanup must live
   * here, not in the caller's finally.
   */
  private async *admitTurn(
    admission: WeightedAdmissionQueue,
    sessionId: string,
    uid: string | undefined,
  ): AsyncGenerator<SseFrame, AdmissionTicket> {
    const tier = await resolveTier(uid);
    const ticket = admission.enqueue(uid ?? "", tier);
    const frameIntervalMs = config.scheduling.queueFrameIntervalMs;
    const deadline = Date.now() + config.scheduling.queueTimeoutMs;

    try {
      while (!ticket.acquired && !ticket.cancelled) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new QueueTimeoutError(ticket.waitedMs);
        }
        const acquired = await ticket.wait(Math.min(frameIntervalMs, remaining));
        if (!acquired && !ticket.cancelled) {
          yield { type: "queue", position: admission.position(ticket), waitedMs: ticket.waitedMs };
        }
      }
      if (!ticket.acquired) {
        // defensive: externally cancelled while queued → same failure path
        throw new QueueTimeoutError(ticket.waitedMs);
      }
      log.info(`[CHAT] admission granted session=${sessionId} uid=${uid ?? "-"} tier=${ticket.tier} waited=${ticket.waitedMs}ms`);
      return ticket;
    } finally {
      if (!ticket.acquired) admission.cancel(ticket);
    }
  }
}
