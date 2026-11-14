import Fastify, { type FastifyReply, type FastifyRequest, type FastifyError } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import type { ChatService } from "../../services/chat.js";
import type { AgentHarness } from "../../harness/app.js";
import type { RAGService } from "../../rag/service.js";
import type { SessionDocumentRepository } from "../../repository/session-docs.js";
import type { ModelCapabilityRegistry } from "../../llm/model-capabilities.js";
import type { ChatSessionRepository, MessageRepository } from "../../repository/persistence.js";
import { registerChatSessionRoutes } from "././routes/chat-sessions.js";
import type { OcrClient } from "../../doc-parser/ocr.js";
import { createLogger, sanitizeUrl } from "../../logger.js";
import { runWithRequestContext, getRequestContext, newRequestId } from "../../context/request-context.js";
import { SlidingWindowLimiter } from "././middleware/rate-limit.js";
import { toErrorPayload } from "././errors.js";
import { config } from "../../config/index.js";
import { MAX_UPLOAD_BYTES } from "././routes/shared.js";
import { registerSystemRoutes } from "././routes/system.js";
import { registerQuotaRoutes } from "././routes/quota.js";
import { registerAiUsageRoutes } from "././routes/ai-usage.js";
import type { QuotaService } from "../../services/quota.js";
import type { UsageLedgerRepository } from "../../repository/usage-ledger.js";
import type { UsageReconciliationJob } from "../../services/usage-reconciliation.js";
import { registerChatRoutes } from "././routes/chat.js";
import { registerPlanRoutes } from "././routes/plans.js";
import type { PlanRunner, PlanRuntimeStats } from "../../agent/dag/runner.js";
import type { PlanRunEngine } from "../../agent/dag/state.js";
import { registerOpenAiCompat } from "././routes/openai.js";
import { registerKgRoutes } from "././routes/kg.js";
import { registerBoardRoutes } from "././routes/board.js";
import { registerSessionSummaryRoutes } from "././routes/session-summary.js";
import { registerQuizRoutes } from "././routes/quiz.js";
import { registerVectorPageRoutes } from "././routes/vector-page.js";
import { registerTaskQuizRoutes } from "././routes/task-quiz.js";
import { registerBlindspotRoutes } from "././routes/blindspot.js";
import { registerSkillsRoutes } from "././routes/skills.js";
import { registerAcademicRoutes } from "././routes/academic.js";
import { registerResearchRoutes } from "././routes/research.js";
import { registerSandboxRoutes } from "././routes/sandbox.js";
import type { ResearchRouteDeps } from "././routes/research.js";
import type { SandboxRouteDeps } from "././routes/sandbox.js";
import type { SkillManager, SkillStoreClient } from "../../skills/manager.js";
import type { BlindspotService } from "../../services/blindspot.js";
import { registerKnowledgeRoutes } from "././routes/knowledge.js";
import type { VideoVectorizerService } from "../../services/video-vectorizer.js";
import type { AppUserBiliClient } from "../../clients/app-user-bili-client.js";
import type { TaskQuizGenerationService } from "../../services/task-quiz-generation.js";
import type { AppTaskClient } from "../../clients/app-task-client.js";
import type { AppUserAuthClient } from "../../clients/app-user-auth-client.js";
import type { KgService } from "../../kg/service.js";
import type { BoardCompletionService } from "../../services/board-completion.js";
import type { SessionSummaryService } from "../../services/session-summary.js";
import type { QuizGenerationService } from "../../services/quiz-generation.js";
import type { QuizGradingService } from "../../services/quiz-grading.js";

/**
 * HTTP assembly ONLY: Fastify instance, global middleware (request-id/ALS,
 * access log, error mapping, 404), and per-domain route registration.
 *
 * Routes live in `routes/` — one module per domain (the equivalent of Java's
 * controller layer), each receiving its dependencies explicitly. This file
 * gains no lines when a domain adds endpoints; a new domain = one new module
 * + one registration line here.
 */

const log = createLogger("HTTP");

export interface BuildServerOptions {
  chat: ChatService;
  harness: AgentHarness;
  rag: RAGService;
  sessionDocs: SessionDocumentRepository;
  capabilities: ModelCapabilityRegistry;
  ocr: OcrClient;
  /** cloud file records (repository layer; Mongo preferred, memory fallback) */
  /** KG facade (service + retriever); absent = kg routes/tool not registered */
  kg?: KgService;
  /** chat session/message stores (exposed as /chat/sessions + /chat/history REST);
   * optional — tests that don't exercise the session routes may omit it */
  chatStores?: { sessions: ChatSessionRepository; messages: MessageRepository };
  /** durable chat image storage (MinIO); absent → history returns legacy inline data URLs */
  chatImages?: import("../../repository/chat-images.js").ChatImageStorage;
  /** member quota gate; absent → /quota/summary not registered */
  quota?: QuotaService;
  /** usage ledger; null still registers /internal/ai-usage (204 sink) */
  ledger?: UsageLedgerRepository | null;
  /** 双账本对账 job（snapshot 进 /agent/runtime）；absent = 无对账段 */
  recon?: UsageReconciliationJob | null;
  /** folder_ids → bvids via app-kg; absent = chat folder scope unresolvable (fail-open unscoped) */
  resolveFolderScope?: (uid: string, folderIds: number[]) => Promise<string[]>;
  /** board AI completion (POST /chat/board/complete); absent = route not registered */
  boardCompletion?: BoardCompletionService;
  /** session summary (POST/GET /chat/sessions/:id/summary); absent = routes not registered */
  summaries?: SessionSummaryService;
  /** quiz AI generation (POST /quiz/generate-from-summary); absent = route not registered */
  quizGen?: QuizGenerationService;
  /** quiz grading (POST /quiz/submit); absent = route not registered */
  quizGrade?: QuizGradingService;
  /** per-page vectorization pipeline; absent = /vec/page/* not registered */
  vectorizer?: VideoVectorizerService;
  /** acquisition-service scope client (knowledge folder status / ownership) */
  appBili?: AppUserBiliClient;
  /** blindspot map service; absent = routes not registered */
  blindspot?: BlindspotService;
  /** skills subsystem; absent = routes not registered */
  skills?: { manager: SkillManager; store: SkillStoreClient };
  /** academic workspace; absent = /academic/* not registered */
  academic?: import("../../services/academic.js").AcademicService;
  /** Word import/export (docs/manuscript-docx.md); absent = those routes are not registered */
  manuscriptDocx?: import("../../services/manuscript-docx.js").ManuscriptDocxService;
  approvals?: import("../../services/research-approval.js").ResearchApprovalService;
  /**
   * research workbench REST extension (experiments/evidence/validation/analysis/
   * workspace; docs/research-ui-api.md §1–§5). Needs `academic` for project
   * ownership/title; absent = those routes are not registered.
   */
  research?: Omit<ResearchRouteDeps, "academic">;
  /** sandbox panel proxy (config.sandbox); absent = /chat/sandbox/* not registered */
  sandbox?: SandboxRouteDeps;
  /** durable plan runs; absent = /chat/plans/* not registered */
  plans?: { engine: PlanRunEngine; runner: PlanRunner };
  /** process-local plan metrics; absent = /agent/runtime omits the plans block */
  planMetrics?: () => PlanRuntimeStats;
  /** scheduled-quiz flow (agent chat + register + executor callback); absent = routes not registered */
  taskQuiz?: {
    generation: TaskQuizGenerationService;
    appTask: AppTaskClient;
    appAuth: AppUserAuthClient;
    /** member usage quota (task-quiz active-task cap); absent = unlimited */
    quota?: QuotaService;
    /** test-only model override for the chat agent */
    agentModel?: Parameters<typeof import("../../services/task-quiz-agent.js").streamTaskQuizAgent>[0]["model"];
  };
}

export async function buildServer(opts: BuildServerOptions) {
  const app = Fastify({
    logger: false, // Access logs are emitted uniformly by the hook below (with requestId/duration); disable Fastify's built-in duplicate
    // multimodal chat payloads carry base64 images inside JSON — 4×2MB + envelope
    bodyLimit: 16 * 1024 * 1024, // Access logs are emitted uniformly by the hook below (with requestId/duration); disable Fastify's built-in duplicate
  });
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES } });

  // ---- Middleware: requestId + request context + security response headers ----
  app.addHook("onRequest", (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const requestId = (req.headers["x-request-id"] as string) || newRequestId();
    const uidHeader = req.headers["x-uid"];
    // uid 保持字符串：int64 超过 Number.MAX_SAFE_INTEGER，Number() 会丢精度
    const uid = typeof uidHeader === "string" && /^\d+$/.test(uidHeader) ? uidHeader : undefined;

    // Attached to the request object: used by the access log (no ALS dependency)
    (req as unknown as { requestId: string; startedAt: number }).requestId = requestId;
    (req as unknown as { startedAt: number }).startedAt = Date.now();
    reply.header("x-request-id", requestId);
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");

    // ALS: lets deep agent/tools code get requestId/uid (done is called within the run scope,
    // so the async chains of later hooks and handlers inherit this context)
    runWithRequestContext({ requestId, uid, startedAt: Date.now() }, done);
  });

  // ---- Middleware: unified structured access log ----
  // One JSON record per request: sanitized URL only (no query secrets, no bodies,
  // no credentials); 5xx → error with the error object, 4xx → warn, slow → warn.
  app.addHook("onResponse", (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    if (!config.log.accessLog.enabled) {
      done();
      return;
    }
    const meta = req as unknown as { requestId?: string; startedAt?: number; logError?: unknown };
    const durationMs = meta.startedAt ? Date.now() - meta.startedAt : -1;
    const userAgent = req.headers["user-agent"];
    const rawContentLength = reply.getHeader("content-length");
    const contentLength =
      typeof rawContentLength === "number"
        ? rawContentLength
        : typeof rawContentLength === "string" && rawContentLength !== "" && Number.isFinite(Number(rawContentLength))
          ? Number(rawContentLength)
          : undefined;
    const slow = durationMs > config.log.accessLog.slowRequestMs;

    const fields: Record<string, unknown> = {
      method: req.method,
      path: sanitizeUrl(req.url),
      route: req.routeOptions?.url,
      status: reply.statusCode,
      duration_ms: durationMs,
      request_id: meta.requestId,
      uid: getRequestContext()?.uid,
      ip: req.ip,
      user_agent: typeof userAgent === "string" ? userAgent.slice(0, 120) : undefined,
      content_length: contentLength,
    };
    if (slow) fields.slow_request = true;
    // 5xx: attach the Error so the record carries type/message/stack (serializer).
    if (reply.statusCode >= 500 && meta.logError !== undefined) fields.err = meta.logError;
    const record = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

    if (reply.statusCode >= 500) {
      log.error(record, "[HTTP] request completed");
    } else if (reply.statusCode >= 400) {
      log.warn(record, "[HTTP] request completed");
    } else {
      log.info(record, "[HTTP] request completed");
      // Extra warning for slow-but-successful requests (already warn/error otherwise).
      if (slow) log.warn(record, "[HTTP] slow request");
    }
    done();
  });

  // ---- Middleware: global error handler (single mapping via toErrorPayload; 5xx sanitized + error_id) ----
  // Structured record with the Error object (type/message/stack) — never a stringified stack
  // in the message. The x-request-id response header is set once in onRequest above.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const requestId = (req as unknown as { requestId?: string }).requestId ?? "-";
    const { status, body } = toErrorPayload(err, requestId);
    // Store the Error for the onResponse access-log record.
    (req as unknown as { logError?: unknown }).logError = err;

    const fields: Record<string, unknown> = {
      method: req.method,
      path: sanitizeUrl(req.url),
      route: req.routeOptions?.url,
      status,
      request_id: requestId,
      uid: getRequestContext()?.uid,
    };
    const record = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (status >= 500) {
      log.error({ ...record, err }, "[HTTP] unhandled error");
    } else {
      log.warn({ ...record, detail: body.detail }, "[HTTP] request rejected");
    }
    void reply.status(status).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ detail: `路径不存在: ${req.method} ${req.url}`, code: "not_found" });
  });

  // ---- Route modules (one per domain; shared chat rate-limit budget) ----
  const limiter = new SlidingWindowLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.max });

  registerSystemRoutes(app, { rag: opts.rag, harness: opts.harness, capabilities: opts.capabilities, quota: opts.quota, recon: opts.recon ?? null, plan: opts.planMetrics });
  // gateway usage-logger sink (always registered — 204 when the ledger is down)
  registerAiUsageRoutes(app, { ledger: opts.ledger ?? null });
  if (opts.quota) {
    registerQuotaRoutes(app, { quota: opts.quota });
  }
  registerChatRoutes(app, { chat: opts.chat, sessionDocs: opts.sessionDocs, chatImages: opts.chatImages, ocr: opts.ocr, limiter, capabilities: opts.capabilities, resolveFolderScope: opts.resolveFolderScope, rag: opts.rag });
  if (opts.plans) registerPlanRoutes(app, opts.plans);
  if (opts.vectorizer && opts.appBili) {
    registerVectorPageRoutes(app, { vectorizer: opts.vectorizer });
    registerKnowledgeRoutes(app, { rag: opts.rag, vectorizer: opts.vectorizer, appBili: opts.appBili, kg: opts.kg });
  }
  if (opts.taskQuiz) {
    registerTaskQuizRoutes(app, opts.taskQuiz);
  }
  if (opts.blindspot) {
    registerBlindspotRoutes(app, { blindspot: opts.blindspot });
  }
  if (opts.skills) {
    registerSkillsRoutes(app, opts.skills);
  }
  if (opts.chatStores) {
    registerChatSessionRoutes(app, { sessions: opts.chatStores.sessions, messages: opts.chatStores.messages, chatImages: opts.chatImages, sessionDocs: opts.sessionDocs });
  }
  if (opts.academic) {
    registerAcademicRoutes(app, {
      academic: opts.academic,
      approvals: opts.approvals,
      manuscriptDocx: opts.manuscriptDocx,
    });
    if (opts.research) registerResearchRoutes(app, { ...opts.research, academic: opts.academic });
  }
  if (opts.sandbox) {
    registerSandboxRoutes(app, opts.sandbox);
  }
  registerOpenAiCompat(app, { harness: opts.harness, model: config.llm.model, limiter });
  if (opts.kg) {
    registerKgRoutes(app, { kg: opts.kg, quota: opts.quota });
  }
  if (opts.boardCompletion) {
    registerBoardRoutes(app, { completion: opts.boardCompletion, quota: opts.quota });
  }
  if (opts.summaries) {
    registerSessionSummaryRoutes(app, { summaries: opts.summaries });
  }
  if (opts.quizGen && opts.quizGrade) {
    registerQuizRoutes(app, { quizGen: opts.quizGen, quizGrade: opts.quizGrade });
  }

  return app;
}
