import { randomUUID } from "node:crypto";
import type { AgentHarness } from "../harness/app.js";
import type { ChatSessionRepository, ChatMessage, MessageRepository, StoredChatImage } from "../repository/persistence.js";
import type { ChatImageStorage } from "../repository/chat-images.js";
import type { SseFrame } from "../transport/sse.js";
import type { Artifact, SearchScope, Source } from "../context/types.js";
import { capArtifacts } from "../artifacts/interactive.js";
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
import type { QuotaGate, QuotaService } from "./quota.js";
import { costMicroYuan, type UsageLedgerRepository } from "../repository/usage-ledger.js";
import { today } from "../utils/datetime.js";
import { historyLimitFor, noteTurnLevel } from "../utils/degrade.js";
import type { PromptRegistry } from "../agent/prompts/loader.js";
import { buildBoardSystemSection, type BoardContextParams } from "./board-context.js";

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
  /** hashed client IP for anonymous (chat_anon) metering; absent = unattributable */
  clientKey?: string;
  /** user-selected installed skills forced into the system prompt */
  skillIds?: string[];
  /**
   * Board (mindmap/whiteboard) chat context parsed at the HTTP layer: the user
   * asked from inside a board node. Rendered into the agent's system prompt as a
   * controlled section (never into tool args / identity).
   */
  board?: BoardContextParams;
  /**
   * Academic project parsed at the HTTP layer: the user asked from inside a
   * research-workbench project. Resolved against the caller's projects and
   * rendered into the system prompt as a controlled section.
   */
  academicProjectId?: string;
  /** Aborted when the SSE client disconnects: cancels generation + in-flight tools
   * and makes sure the assistant message is finalized instead of left pending. */
  signal?: AbortSignal;
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

/**
 * QUOTA_EXCEEDED / COST_GUARD SSE error frame: the frontend
 * renders an upgrade card off `code` + `detail` (resetAt / upgradeSku).
 */
function quotaErrorFrame(gate: QuotaGate): SseFrame {
  const costGuard = gate.verdict === "cost_guard";
  return {
    type: "error",
    code: costGuard ? "COST_GUARD" : "QUOTA_EXCEEDED",
    message: costGuard
      ? "今日 AI 使用成本已达上限，明日 0 点自动恢复"
      : gate.tier === "free" && gate.kind === "chat_anon"
        ? "今日未登录体验额度已用完，登录解锁每日更多额度"
        : `今日额度已用完（${gate.used}/${gate.limit}），明日 0 点重置`,
    detail: {
      kind: gate.kind,
      used: gate.used,
      limit: gate.limit,
      resetAt: gate.resetAt,
      tier: gate.tier,
      upgradeSku: gate.tier === "free" ? "VIP_MONTHLY" : "SVIP_MONTHLY",
    },
  };
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
    /** member usage quota; undefined/null → quota disabled */
    private readonly quota?: QuotaService | null,
    /** usage ledger; absent → cost accounting disabled */
    private readonly ledger?: UsageLedgerRepository | null,
    /** prompt registry for turn-level system directives (board context); absent → no injection */
    private readonly prompts?: PromptRegistry,
    /** renders the academic-project section for a turn; absent/unknown → no injection */
    private readonly academicContextSection?: (
      uid: string | undefined,
      projectId: string,
    ) => Promise<string | undefined>,
  ) {}

  private get admissionQueue(): WeightedAdmissionQueue | null {
    return this.admission === undefined ? getAdmissionQueue() : this.admission;
  }

  async *askStream(req: AskStreamRequest): AsyncGenerator<SseFrame> {
    // ---- quota gate: first in line — no persistence, no
    // admission slot, no harness dispatch. gate=null → quota disabled or the
    // request is unattributable (no uid && no clientKey).
    const gate = this.quota
      ? await this.quota.beginChatTurn(req.uid, req.clientKey).catch((err: unknown) => {
          log.warn(`[CHAT] quota gate error (fail-open): ${err instanceof Error ? err.message : err}`);
          return null;
        })
      : null;
    if (gate && gate.verdict !== "allow") {
      log.warn(`[CHAT] quota ${gate.verdict} kind=${gate.kind} uid=${req.uid ?? "-"} used=${gate.used}/${gate.limit}`);
      yield quotaErrorFrame(gate);
      yield { type: "done" };
      return;
    }
    // 降级阶梯登记：工具层（检索条数）与主循环（输出预算）按 uid 读取本轮级别
    if (req.uid) noteTurnLevel(req.uid, gate?.level ?? "L0");
    if (gate && req.images?.length) {
      // attachments meter BEFORE storage: over budget → reject before any write
      const imagesOk = await this.quota!
        .consumeImages(req.uid, req.clientKey, req.images.length)
        .catch((err: unknown) => {
          log.warn(`[CHAT] image quota check failed (fail-open): ${err instanceof Error ? err.message : err}`);
          return true;
        });
      if (!imagesOk) {
        log.warn(`[CHAT] image quota exceeded uid=${req.uid ?? "-"} n=${req.images.length}`);
        yield {
          type: "error",
          code: "QUOTA_EXCEEDED",
          message: "今日图片附件额度已用完，明日 0 点重置",
          detail: { kind: "chat_images", resetAt: gate.resetAt, tier: gate.tier, upgradeSku: gate.tier === "free" ? "VIP_MONTHLY" : "SVIP_MONTHLY" },
        };
        yield { type: "done" };
        return;
      }
    }
    const sessionId = req.sessionId ?? randomUUID();
    const session = await this.sessions.getOrCreate(sessionId, req.uid);
    const stored = req.images?.length ? await this.storeImages(session.id, req.images) : undefined;
    const { assistantMsg } = await this.messages.beginTurn(session.id, req.query, stored?.inlineImages, stored?.refs);

    const history = await this.hydrateHistoryImages(
      await this.messages.recentMessages(
        session.id,
        req.historyLimit ?? historyLimitFor(config.context.recentKeep, gate?.level ?? "L0"),
      ),
    );
    const effectiveScope = scopeIsEmpty(req.scope) ? inheritScopeFromHistory(history) : (req.scope ?? {});
    if (scopeIsEmpty(req.scope) && !scopeIsEmpty(effectiveScope)) {
      log.info(`[CHAT] scope inherited from previous sources session=${sessionId}`);
    }

    let fullContent = "";
    let finalSources: Source[] = [];
    // Artifacts are streamed to the client today; collecting them here makes the
    // cards survive a history reload (bounded per turn by capArtifacts).
    let finalArtifacts: Artifact[] = [];
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    let hadError = false;

    // Finalization must happen on every path, including client disconnect: when
    // the SSE consumer goes away the generator's `return` skips the code after
    // the loop, so the `finally` below still closes the message out.
    let finalized = false;
    const finalizeAssistantTurn = async (patch: {
      sources?: Source[];
      artifacts?: Artifact[];
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      status: "done" | "failed";
      error?: string;
    }): Promise<void> => {
      if (finalized) return;
      finalized = true;
      try {
        await this.messages.finalizeTurn(assistantMsg.id, patch);
      } catch (err) {
        log.warn(`[CHAT] finalize failed session=${sessionId}: ${err instanceof Error ? err.message : err}`);
      }
    };

    // Turn-level context directives (board node / academic project) ride on
    // extraSystem; the agent's own prompt and red lines stay authoritative.
    const extraSystem = await this.buildExtraSystem(req.board, req.uid, req.academicProjectId);

    const admission = this.admissionQueue;
    let ticket: AdmissionTicket | null = null;

    // Whole-turn cancellation: the same controller carries client disconnect and
    // the turn deadline. A stalled LLM stream therefore cannot keep the turn (and
    // its session lock) alive forever; the two causes are tracked separately so a
    // deadline surfaces an error frame while a disconnect stays silent.
    const turnAbort = new AbortController();
    const onClientAbort = () => turnAbort.abort();
    if (req.signal) {
      if (req.signal.aborted) turnAbort.abort();
      else req.signal.addEventListener("abort", onClientAbort, { once: true });
    }
    let deadlineHit = false;
    const turnTimer = setTimeout(() => {
      deadlineHit = true;
      turnAbort.abort();
    }, config.agent.turnTimeoutMs);

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
        ...(extraSystem ? { extraSystem } : {}),
        signal: turnAbort.signal,
      })) {
        if (turnAbort.signal.aborted) break;
        if (frame.type === "chunk") {
          fullContent += frame.content;
          await this.messages.appendChunk(assistantMsg.id, frame.content);
        } else if (frame.type === "sources") {
          finalSources = frame.sources;
        } else if (frame.type === "artifact") {
          finalArtifacts = capArtifacts([...finalArtifacts, ...frame.artifacts]);
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
      const aborted = turnAbort.signal.aborted;
      await finalizeAssistantTurn({
        sources: finalSources,
        ...(finalArtifacts.length > 0 ? { artifacts: finalArtifacts } : {}),
        usage,
        status: aborted || hadError ? "failed" : "done",
        ...(aborted
          ? { error: deadlineHit ? "本轮处理超时，已中止" : "连接已断开，生成已取消" }
          : {}),
      });
      if (aborted) {
        if (deadlineHit) {
          yield { type: "error", message: "本轮处理超时，已中止。请重试，或把任务拆小后分步提问。" };
        }
        // disconnect: the consumer is gone; deadline: the error frame above is the answer
        yield { type: "done" };
        return;
      }
      if (usage && (usage.totalTokens || usage.outputTokens)) {
        log.info(`[CHAT] turn usage session=${sessionId} in=${usage.inputTokens ?? "?"} out=${usage.outputTokens ?? "?"} total=${usage.totalTokens ?? "?"}`);
      }
      // consume-on-success — turn count + day cost + ledger row.
      // Failed/retried turns never consume (they short-circuit above via hadError).
      if (this.quota && !hadError) {
        await this.quota.completeChatTurn(req.uid, req.clientKey, usage, config.llm.model).catch((err: unknown) => {
          log.warn(`[CHAT] quota consume failed (ignored): ${err instanceof Error ? err.message : err}`);
        });
      }
      if (this.ledger && !hadError) {
        void this.ledger
          .recordTurn({
            day: today(),
            uid: req.uid ?? "0",
            purpose: "chat",
            model: config.llm.model,
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            costMicroYuan: costMicroYuan(usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, config.quota.prices[config.llm.model]),
          })
          .catch((err: unknown) => log.warn(`[CHAT] usage ledger write failed: ${err instanceof Error ? err.message : err}`));
      }
      await this.sessions.touch(session.id);
      if (!hadError) {
        this.compression?.schedule(session.id);
        // first turn of a session → generate the title in the background
        if (!session.title) this.titleGen?.(session.id, req.query);
      }
    } catch (err) {
      await finalizeAssistantTurn({ status: "failed" });
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
      clearTimeout(turnTimer);
      if (req.signal) req.signal.removeEventListener("abort", onClientAbort);
      // Disconnect path: the consumer closed the generator, so the code after
      // the loop never ran. Close the message (partial content is kept) instead
      // of leaving it pending forever.
      if (!finalized) {
        await finalizeAssistantTurn({
          status: "failed",
          error: deadlineHit ? "本轮处理超时，已中止" : "连接已断开，生成已取消",
        });
      }
      // `ticket` is non-null only once granted (admitTurn cleans up its own
      // queued ticket on every unwinding path, including disconnect).
      if (admission && ticket) {
        if (ticket.acquired) admission.release(ticket);
        else admission.cancel(ticket); // defensive; unreachable today
      }
    }
  }

  /**
   * Turn-level system directives: board context plus (when the caller came from
   * the research workbench) the academic project section. Returns undefined when
   * the turn carries neither; a failed/foreign project lookup is ignored so a
   * stale project id can never fail the conversation.
   */
  private async buildExtraSystem(
    board: BoardContextParams | undefined,
    uid: string | undefined,
    academicProjectId: string | undefined,
  ): Promise<string | undefined> {
    const sections: string[] = [];
    if (board && this.prompts) {
      sections.push(buildBoardSystemSection(this.prompts, board));
    }
    if (academicProjectId && this.academicContextSection) {
      const section = await this.academicContextSection(uid, academicProjectId).catch((err: unknown) => {
        log.warn(`[CHAT] academic context ignored project=${academicProjectId}: ${err instanceof Error ? err.message : err}`);
        return undefined;
      });
      if (section) sections.push(section);
    }
    return sections.length > 0 ? sections.join("\n\n") : undefined;
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
