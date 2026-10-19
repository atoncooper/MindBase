import { config, configSources } from "../config/index.js";
import { setupTracing, shutdownTracing } from "../llm/tracing.js";
import { createRAGService } from "../rag/bootstrap.js";
import { ModelCapabilityRegistry } from "../llm/model-capabilities.js";
import { GatewayVisionOcr, DisabledOcr, type OcrClient } from "../doc-parser/ocr.js";
import { ToolRegistry } from "../tools/registry.js";
import { AgentRuntime } from "../tools/runtime.js";
import { createVectorSearchTool } from "../tools/chat/vector-search.js";
import { createKgSearchTool } from "../tools/chat/kg-search.js";
import { createListVideosTool, createGetVideoSummariesTool } from "../tools/chat/list-videos.js";
import { createSaveMemoryTool } from "../tools/memory/index.js";
import { createSaveNoteTool } from "../tools/note/index.js";
import { createRunCodeTool } from "../tools/code/index.js";
import { createEmitQuizTool, createEmitGradingTool } from "../tools/quiz/index.js";
import { McpClient, registerMcpTools } from "../mcp/index.js";
import { buildServer } from "../transport/http/server.js";
import { createDelegateTool } from "../tools/harness/delegate.js";
import { createAskUserTool } from "../tools/interaction/ask-user.js";
import { createFetchWebpageTool } from "../tools/web/fetch-page.js";
import { createWebSearchTool } from "../tools/web/search.js";
import { createFetchPortWithDeepseekPrimary } from "../tools/web/deepseek.js";
import { HttpWebFetch } from "../tools/web/fetcher.js";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import { AgentLifecycleManager } from "../agent/lifecycle.js";
import { PromptRegistry } from "../agent/prompts/loader.js";
import { SUB_AGENTS } from "../agent/manifest.js";
import { createMainAgent } from "../agent/main/agent.js";
import { createNoteAgent } from "../agent/note/agent.js";
import { createCodeAgent } from "../agent/code/agent.js";
import { createQuizAgent } from "../agent/quiz/agent.js";
import { createBoardAgent } from "../agent/board/agent.js";
import { AgentHarness } from "../harness/app.js";
import { ChatService } from "../services/chat.js";
import { BoardCompletionService } from "../services/board-completion.js";
import { SessionSummaryService } from "../services/session-summary.js";
import { QuizGenerationService } from "../services/quiz-generation.js";
import { QuizGradingService } from "../services/quiz-grading.js";
import { AppQuizClient } from "../services/app-quiz-client.js";
import { QuotaService } from "../services/quota.js";
import { UsageReconciliationJob } from "../services/usage-reconciliation.js";
import { RedisQuotaCounter } from "../repository/redis/quota-counter.js";
import { MemoryQuotaCounter } from "../repository/memory/quota-counter.js";
import type { QuotaCounterStore } from "../repository/quota.js";
import { MemoryUsageLedger } from "../repository/memory/usage-ledger.js";
import { MongoUsageLedger } from "../repository/mongo/usage-ledger.js";
import type { UsageLedgerRepository } from "../repository/usage-ledger.js";
import { MemorySessionSummaryStore } from "../repository/memory/session-summaries.js";
import type { SessionSummaryRepository } from "../repository/session-summaries.js";
import { MongoSessionSummaryStore } from "../repository/mongo/session-summaries.js";
import { getAdmissionQueue } from "../services/admission.js";
import { ContextCompressionService } from "../services/context-compression.js";
import { generateTitle } from "../services/title.js";
import {
  MemoryChatSessionRepository,
  MemoryMessageRepository,
} from "../repository/memory/chat-store.js";
import { MongoChatStore } from "../repository/mongo/chat-store.js";
import { MongoQuizResumeStore } from "../repository/mongo/quiz-resume.js";
import { MemoryQuizResumeStore } from "../repository/memory/quiz-resume.js";
import type { QuizResumeStore } from "../repository/quiz-resume.js";
import type { ChatSessionRepository, MessageRepository } from "../repository/persistence.js";
import { MemoryVideoMetaRepository, defaultSeed } from "../repository/memory/video-meta.js";
import { MemoryMemoryStore } from "../repository/memory/memory-store.js";
import { NoopCodeExecution } from "../tools/code/code-execution.js";
import { MemorySessionDocumentStore } from "../repository/memory/session-docs.js";
import { GrpcKgGraphRepository } from "../repository/grpc/kg-graph.js";
import { MemoryKgGraphRepository } from "../repository/memory/kg-graph.js";
import { MemoryKgSourceStore } from "../repository/memory/kg-sources.js";
import { MongoKgSourceStore } from "../repository/mongo/kg-sources.js";
import { MemoryKgBuildStore } from "../repository/memory/kg-builds.js";
import { MongoKgBuildStore } from "../repository/mongo/kg-builds.js";
import { KgEntityIndex } from "../repository/kg-entity-index.js";
import { KgService } from "../kg/service.js";
import { KgExtractor } from "../kg/extractor.js";
import { KgRetriever } from "../kg/retriever.js";
import type { KgGraphRepository } from "../repository/kg-graph.js";
import { MemoryAgentContextStore } from "../repository/memory/agent-context.js";
import { MongoSessionDocumentStore } from "../repository/mongo/session-docs.js";
import { MongoAgentContextStore } from "../repository/mongo/agent-context.js";
import { MemoryVectorTaskStore } from "../repository/memory/vector-tasks.js";
import { MongoVectorTaskStore } from "../repository/mongo/vector-tasks.js";
import { AppBiliClient } from "../services/app-bili-client.js";
import { VideoVectorizerService } from "../services/video-vectorizer.js";
import { BiliEventBridge } from "../bootstrap/redis-events.js";
import { AppTaskClient } from "../services/app-task-client.js";
import { AppAuthClient } from "../services/app-auth-client.js";
import { MemoryTaskQuizDocStore } from "../repository/memory/task-quiz-docs.js";
import { MongoTaskQuizDocStore } from "../repository/mongo/task-quiz-docs.js";
import { TaskQuizGenerationService } from "../services/task-quiz-generation.js";
import { BlindspotService } from "../services/blindspot.js";
import { SkillManager, SkillStoreClient } from "../skills/manager.js";
import { createSkillZipStore } from "../skills/minio-store.js";
import { createMinioChatImageStorage } from "../repository/minio/chat-images.js";
import { createMemoryChatImageStorage } from "../repository/memory/chat-images.js";
import { MemorySkillMetaStore } from "../repository/memory/skills.js";
import { MongoSkillMetaStore } from "../repository/mongo/skills.js";
import { createLoadSkillTool } from "../tools/skills/load-skill.js";
import type { SessionDocumentRepository } from "../repository/session-docs.js";
import type { VectorTaskRepository } from "../repository/vector-tasks.js";
import type { AgentContextRepository } from "../repository/agent-context.js";
import type { AgentContextBinding } from "../agent/react.js";
import { installProcessErrorHandlers } from "../bootstrap/process-errors.js";
import { createLogger, closeLogger } from "../logger.js";

const log = createLogger("BOOT");

/**
 * Composition root: wiring DI → Harness → Fastify (the process entry is a thin
 * launcher in index.ts).
 * Any unavailable dependency (Milvus/gateway offline) degrades startup instead of crashing.
 */
/** Wire everything and start serving. */
export async function bootstrap() {
  // 0. LangSmith tracing (OTLP): no LANGSMITH_API_KEY → fully disabled
  setupTracing();

  // 1. Data ports: chat history prefers MongoDB (MONGO__URI config), falls back to in-memory if unreachable
  let sessions: ChatSessionRepository = new MemoryChatSessionRepository();
  let messages: MessageRepository = new MemoryMessageRepository();
  // KG graph store handle — also serves chat folder-scope resolution (app-kg reads
  // collection/favorite_folders); stays undefined until the kg block connects it.
  let kgRepository: KgGraphRepository | undefined;
  let kgIndex: KgEntityIndex | undefined;
  if (config.mongo.uri) {
    const mongo = await MongoChatStore.connect();
    if (mongo) {
      sessions = mongo;
      messages = mongo;
      log.info(`[BOOT] chat persistence: mongodb db=${config.mongo.database}`);
    } else {
      log.warn("[BOOT] chat persistence: memory fallback (mongodb unreachable)");
    }
  } else {
    log.warn("[BOOT] chat persistence: memory fallback (MONGO__URI not set)");
  }
  const videoMeta = new MemoryVideoMetaRepository(defaultSeed());

  // 2. RAG (enters degraded mode when Milvus is unavailable; init wiring lives in rag/bootstrap.ts)
  const rag = await createRAGService();

  // 2.45 Chat image attachments: MinIO-backed (chat-images/*); display signs
  //      presigned URLs against the PUBLIC endpoint, model context reads back
  //      data URLs. Memory fallback → inline data URLs on the message doc.
  const chatImages = createMinioChatImageStorage() ?? createMemoryChatImageStorage();
  log.info(`[BOOT] chat images: ${chatImages.durable ? "minio (durable)" : "memory fallback (inline data urls)"}`);

  // 2.5 Session documents: uploaded within a conversation, scoped strictly to that session.
  //     Mongo preferred (embedding-based retrieval, gateway offline falls back to keyword); memory fallback.
  let sessionDocs: SessionDocumentRepository = new MemorySessionDocumentStore();
  let mongoSessionDocs: MongoSessionDocumentStore | null = null;
  if (config.mongo.uri) {
    mongoSessionDocs = await MongoSessionDocumentStore.connect(rag.embeddings);
    if (mongoSessionDocs) sessionDocs = mongoSessionDocs;
    else log.warn("[BOOT] session documents: memory fallback (mongodb unreachable)");
  } else {
    log.warn("[BOOT] session documents: memory fallback (MONGO__URI not set)");
  }


  // 2.65 Session summaries: the summary button's own store (separate from chat
  //      messages by design). Mongo preferred, memory fallback.
  let summaries: SessionSummaryRepository = new MemorySessionSummaryStore();
  let mongoSummaries: MongoSessionSummaryStore | null = null;
  if (config.mongo.uri) {
    mongoSummaries = await MongoSessionSummaryStore.connect();
    if (mongoSummaries) summaries = mongoSummaries;
    else log.warn("[BOOT] session summaries: memory fallback (mongodb unreachable)");
  } else {
    log.warn("[BOOT] session summaries: memory fallback (MONGO__URI not set)");
  }

  // 2.7 Video vectorization bookkeeping: per-page vector state + pipeline task
  //     records (Mongo preferred, memory fallback). Serves /vec/page/* and the
  //     /knowledge non-kg surface; the bili:page_ready Redis subscriber feeds it.
  let vecTasks: VectorTaskRepository = new MemoryVectorTaskStore();
  let mongoVecTasks: MongoVectorTaskStore | null = null;
  if (config.mongo.uri) {
    mongoVecTasks = await MongoVectorTaskStore.connect();
    if (mongoVecTasks) vecTasks = mongoVecTasks;
    else log.warn("[BOOT] vector bookkeeping: memory fallback (mongodb unreachable)");
  } else {
    log.warn("[BOOT] vector bookkeeping: memory fallback (MONGO__URI not set)");
  }
  // 2.72 Quota + usage ledger: Redis daily counters (fail-open on
  //      store errors at the service layer) + the cost ledger (Mongo preferred).
  let quotaCounter: QuotaCounterStore = new MemoryQuotaCounter();
  let redisQuotaCounter: RedisQuotaCounter | null = null;
  if (config.redis.url) {
    redisQuotaCounter = new RedisQuotaCounter(config.redis.url);
    quotaCounter = redisQuotaCounter;
    log.info("[BOOT] quota counter: redis (fail-open on store errors)");
  } else {
    log.info("[BOOT] quota counter: memory fallback (REDIS__URL not set)");
  }
  const quota = new QuotaService({ counter: quotaCounter });
  if (!config.appPay.apiKey) {
    // 部署级事故要启动时喊出来：key 缺失时所有用户档位永远按 free 解析
    //（配额展示与加权排队静默降级），比线上逐请求 warn 更可发现。
    log.error(
      "[BOOT] APISIX_CONSUMER_KEY 未配置（appPay.apiKey 为空）——所有用户的会员档位将永远按 free 解析" +
        "（配额展示与加权排队降级）。请在 .env 配置 APISIX_CONSUMER_KEY 并重启。",
    );
  }
  let usageLedger: UsageLedgerRepository = new MemoryUsageLedger();
  let mongoUsageLedger: MongoUsageLedger | null = null;
  if (config.mongo.uri) {
    mongoUsageLedger = await MongoUsageLedger.connect();
    if (mongoUsageLedger) usageLedger = mongoUsageLedger;
    else log.warn("[BOOT] usage ledger: memory fallback (mongodb unreachable)");
  } else {
    log.warn("[BOOT] usage ledger: memory fallback (MONGO__URI not set)");
  }
  const reconJob = new UsageReconciliationJob(usageLedger);
  const appBili = new AppBiliClient();
  // ASR transcript source (cross-DB read of mind_base.asr_documents) — a
  // dedicated connection; the kg block owns its own instance.
  const vecSources = config.mongo.uri ? await MongoKgSourceStore.connect() : null;
  if (!vecSources) log.warn("[BOOT] vectorizer ASR source unavailable — pages will fail per-page");
  const vectorizer = new VideoVectorizerService({
    rag,
    sources: vecSources ?? new MemoryKgSourceStore(),
    tasks: vecTasks,
    countPageVectors: (bvid, pageIndex) => rag.countPageVectors(bvid, pageIndex),
    quota,
  });

  // Prompts load before any service that renders them (task-quiz / quiz generation /
  // agents / kg extractor all read from the registry below).
  const prompts = PromptRegistry.load();
  log.info(`[BOOT] prompts loaded: ${prompts.names().join(", ")}`);

  // 2.8 Scheduled-quiz flow: generation docs in the SHARED Mongo collection
  //     (mind_base.task_quiz_questions, read by app-quiz); task rows go through
  //     app-quiz's internal face; email/completion callbacks via app-task.
  const appTask = new AppTaskClient();
  const appAuth = new AppAuthClient();
  const appQuizClient = new AppQuizClient();
  let quizDocs: MongoTaskQuizDocStore | MemoryTaskQuizDocStore = new MemoryTaskQuizDocStore();
  let mongoQuizDocs: MongoTaskQuizDocStore | null = null;
  if (config.mongo.uri) {
    mongoQuizDocs = await MongoTaskQuizDocStore.connect();
    if (mongoQuizDocs) quizDocs = mongoQuizDocs;
    else log.warn("[BOOT] task-quiz docs: memory fallback (mongodb unreachable)");
  }
  const taskQuizGeneration = new TaskQuizGenerationService({
    docs: quizDocs,
    appQuiz: appQuizClient,
    appTask,
    prompts,
  });

  // 3. Tool registration + Runtime
  const registry = new ToolRegistry();
  registry.register(createVectorSearchTool(rag));
  // list_videos/get_video_summaries are backed by the VideoMetaRepository stub —
  // keep them off the agent until real video metadata lands (config gate).
  if (config.toolsStub?.videoMeta) {
    registry.register(createListVideosTool(videoMeta));
    registry.register(createGetVideoSummariesTool(videoMeta));
  }
  const memoryStore = new MemoryMemoryStore();
  registry.register(createSaveMemoryTool(memoryStore));
  registry.register(createAskUserTool);
  const webFetch = createFetchPortWithDeepseekPrimary(new HttpWebFetch());
  registry.register(createFetchWebpageTool(webFetch));
  registry.register(createWebSearchTool());

  // 2.7 KG (knowledge graph): AI (extraction/retrieval/build) here, storage
  //     (Neo4j + video.kg bookkeeping) in the app-kg Go service over gRPC.
  //     kgGrpc disabled OR app-kg unreachable → graceful degradation, no tool/routes.
  // 2.9 Skills subsystem: zip content in MinIO + metadata in app-ts's own
  //     Mongo (mind_base_ts.skills_meta). Disabled when MINIO__ENDPOINT unset.
  let skillManager: SkillManager | undefined;
  let skillStore: SkillStoreClient | undefined;
  let mongoSkillMeta: MongoSkillMetaStore | MemorySkillMetaStore | null = null;
  if (config.skills.enabled) {
    const zipStore = createSkillZipStore();
    if (zipStore) {
      mongoSkillMeta = config.mongo.uri ? await MongoSkillMetaStore.connect() : null;
      const meta = mongoSkillMeta ?? new MemorySkillMetaStore();
      skillManager = new SkillManager({ zipStore, meta });
      skillStore = new SkillStoreClient();
      log.info("[BOOT] skills subsystem ready");
    } else {
      log.info("[BOOT] skills disabled (MINIO__ENDPOINT not set)");
    }
  } else {
    log.info("[BOOT] skills disabled (config)");
  }

  let kgService: KgService | undefined;
  if (config.kg.enabled && config.kgGrpc.enabled) {
    let graph: KgGraphRepository;
    try {
      graph = await GrpcKgGraphRepository.connect();
      log.info(`[BOOT] kg graph store: grpc ${config.kgGrpc.target}`);
    } catch (err) {
      graph = new MemoryKgGraphRepository();
      log.warn(`[BOOT] kg graph store unreachable, memory fallback (KG data will not persist): ${err instanceof Error ? err.message : err}`);
    }
    kgRepository = graph;
    const sources = config.mongo.uri ? await MongoKgSourceStore.connect() : null;
    if (!sources) log.warn("[BOOT] kg ASR sources unavailable — build pages will fail per-page");
    const builds = config.mongo.uri ? await MongoKgBuildStore.connect() : null;
    const index = await KgEntityIndex.connect(rag.embeddings);
    kgIndex = index ?? undefined;
    log.info(`[BOOT] kg entity index: ${index ? `ready (${config.kg.collectionName})` : "unavailable (semantic linking degraded)"}`);
    const extractor = new KgExtractor({
      systemPrompt: prompts.render("kg/extract", {}),
      extractModel: config.kg.extractModel,
      maxTextChars: config.kg.maxTextChars,
    });
    kgService = new KgService({
      graph,
      extractor,
      sources: sources ?? new MemoryKgSourceStore(),
      builds: builds ?? new MemoryKgBuildStore(),
      index,
      embeddings: rag.embeddings,
    });
    registry.register(createKgSearchTool(new KgRetriever({ graph, index, embeddings: rag.embeddings })));
    log.info("[BOOT] kg_search tool registered");
  } else {
    log.info("[BOOT] kg disabled — kg_search tool and /knowledge/kg/* routes not registered");
  }
  // Note saving: goes through app-note-mcp (save_note) — never the note tables directly.
  if (config.noteMcp.enabled) {
    const noteMcpHeaders: Record<string, string> = {};
    if (config.noteMcp.bearerToken) noteMcpHeaders["Authorization"] = `Bearer ${config.noteMcp.bearerToken}`;
    // MCP server 服务模式认 APISIX 惯例的 `apikey` 头（serve.go: Header.Get("apikey")），
    // 不是 X-Api-Key——头名错位会被服务端当作未带凭证而 401
    if (config.noteMcp.apiKey) noteMcpHeaders["apikey"] = config.noteMcp.apiKey;
    const noteMcp = new McpClient({
      name: "note",
      url: config.noteMcp.url,
      timeoutMs: config.noteMcp.timeoutMs,
      defaultHeaders: noteMcpHeaders,
    });
    registry.register(createSaveNoteTool(noteMcp));
    log.info(`[BOOT] note MCP tool registered (${config.noteMcp.url})`);
  } else {
    log.info("[BOOT] note MCP disabled — save_note not registered");
  }
  const codeExec = new NoopCodeExecution();
  registry.register(createRunCodeTool(codeExec));
  // Quiz generation: the quiz agent authors questions; persistence goes through
  // app-quiz-mcp (save_quiz / save_grading) — never the quiz tables directly.
  if (config.quizMcp.enabled) {
    const quizMcpHeaders: Record<string, string> = {};
    if (config.quizMcp.bearerToken) quizMcpHeaders["Authorization"] = `Bearer ${config.quizMcp.bearerToken}`;
    if (config.quizMcp.apiKey) quizMcpHeaders["apikey"] = config.quizMcp.apiKey;
    const quizMcp = new McpClient({
      name: "quiz",
      url: config.quizMcp.url,
      timeoutMs: config.quizMcp.timeoutMs,
      defaultHeaders: quizMcpHeaders,
    });
    registry.register(createEmitQuizTool(quizMcp));
    registry.register(createEmitGradingTool(quizMcp));
    log.info(`[BOOT] quiz MCP tools registered (${config.quizMcp.url})`);
  } else {
    log.info("[BOOT] quiz MCP disabled — quiz tools not registered");
  }
  // MCP dynamic tool bridge (src/mcp/): the app-board-mcp server OWNS its tools —
  // they are discovered via tools/list and registered verbatim; auth headers are
  // injected here (boardMcp config), uid travels per-call as X-Uid.
  let boardCompletion: BoardCompletionService | undefined;
  if (config.boardMcp.enabled) {
    const boardMcpHeaders: Record<string, string> = {};
    if (config.boardMcp.bearerToken) boardMcpHeaders["Authorization"] = `Bearer ${config.boardMcp.bearerToken}`;
    if (config.boardMcp.apiKey) boardMcpHeaders["apikey"] = config.boardMcp.apiKey;
    const boardMcp = new McpClient({
      name: "board",
      url: config.boardMcp.url,
      timeoutMs: config.boardMcp.timeoutMs,
      defaultHeaders: boardMcpHeaders,
    });
    // discoveryUid="1"：service-mode 网关要求正整数 X-Uid（uid<=0 拒绝），boot
    // 发现无用户会话；tools/list 只返回工具元数据不触达上游，真实调用仍按会话
    // uid 走 X-Uid
    const registered = await registerMcpTools(registry, boardMcp, { maxContentChars: config.boardMcp.maxContentChars, discoveryUid: "1" });
    log.info(`[BOOT] board MCP tools registered: ${registered} (${config.boardMcp.url})`);
    // /chat/board/complete reuses the same service-mode client (GET board + one
    // structured LLM call); route is registered only when this block ran.
    boardCompletion = new BoardCompletionService({
      client: boardMcp,
      completionModel: config.boardMcp.completionModel,
    });
  } else {
    log.info("[BOOT] board MCP disabled — board tools not registered");
  }
  const runtime = new AgentRuntime(() => registry.list());

  // 5. Context services: shared summary compression + per-agent persistent contexts.
  //    Must be wired before agent creation (sub-agents take the binding).
  //    (prompts were loaded in section 2.7 — the kg extractor renders at wiring time)
  const compression = new ContextCompressionService(sessions, messages, prompts);
  let agentContext: AgentContextRepository = new MemoryAgentContextStore();
  let mongoAgentContexts: MongoAgentContextStore | null = null;
  if (config.mongo.uri) {
    mongoAgentContexts = await MongoAgentContextStore.connect();
    if (mongoAgentContexts) agentContext = mongoAgentContexts;
    else log.warn("[BOOT] agent contexts: memory fallback (mongodb unreachable)");
  } else {
    log.warn("[BOOT] agent contexts: memory fallback (MONGO__URI not set)");
  }
  const contextBinding: AgentContextBinding = {
    port: agentContext,
    sharedSummary: (id) => sessions.getSummary(id),
    compression,
  };

  // 6. Agent orchestration: main is the only routing target; note/code/quiz/board are sub-agents reachable via delegate_to_agent
  //    (memory recall happens in the context layer, not through agents)
  const orchestrator = new AgentOrchestrator(prompts);
  const lifecycle = new AgentLifecycleManager();
  // sub-agent roster comes from src/agent/manifest.ts — the single source shared
  // with each agent factory's self-description (no duplicated descriptions here)
  registry.register(createDelegateTool(lifecycle, SUB_AGENTS.map(({ name, description }) => ({ name, description }))));

  const hasKnowledgeData = async () => {
    const stats = await rag.getCollectionStats();
    return stats.available && stats.totalChunks > 0;
  };
  if (skillManager) {
    registry.register(createLoadSkillTool(skillManager));
    log.info("[BOOT] load_skill tool registered");
  }
  const mainAgent = createMainAgent(
    runtime,
    hasKnowledgeData,
    memoryStore,
    prompts,
    sessionDocs,
    (id) => sessions.getSummary(id),
    kgService !== undefined,
    skillManager
      ? { indexSection: (uid) => skillManager.indexSection(uid), forcedSection: (uid, ids) => skillManager.forcedSection(uid, ids) }
      : undefined,
  );
  const noteAgent = createNoteAgent(runtime, prompts, contextBinding);
  const codeAgent = createCodeAgent(runtime, prompts, contextBinding);
  const quizAgent = createQuizAgent(runtime, prompts, contextBinding);
  const boardAgent = createBoardAgent(runtime, prompts, contextBinding);
  lifecycle.register(mainAgent.name, () => mainAgent);
  lifecycle.register(noteAgent.name, () => noteAgent);
  lifecycle.register(codeAgent.name, () => codeAgent);
  lifecycle.register(quizAgent.name, () => quizAgent);
  lifecycle.register(boardAgent.name, () => boardAgent);
  orchestrator.register(mainAgent, true);

  const harness = new AgentHarness(registry, runtime, orchestrator, lifecycle);

  // 6. HTTP (+ model capability registry: OpenRouter metadata, background refresh;
  //          OCR client for image documents, disabled unless OCR__ENABLED=true)
  const capabilities = new ModelCapabilityRegistry();
  capabilities.startBackgroundRefresh();
  const ocr: OcrClient = config.ocr.enabled
    ? new GatewayVisionOcr(config.ocr.model, capabilities)
    : new DisabledOcr();
  log.info(`[BOOT] ocr: ${config.ocr.enabled ? `enabled model=${config.ocr.model}` : "disabled"}`);
  const admission = getAdmissionQueue();
  log.info(
    admission
      ? `[BOOT] chat admission: maxConcurrent=${config.scheduling.maxConcurrent} queueMaxSize=${config.scheduling.queueMaxSize} timeoutMs=${config.scheduling.queueTimeoutMs}`
      : "[BOOT] chat admission: disabled",
  );
  const chat = new ChatService(harness, sessions, messages, compression, (id, q) => {
    void generateTitle(sessions, prompts, id, q);
  }, admission, chatImages, quota, usageLedger);
  const resolveFolderScope = kgRepository
    ? (uid: string, folderIds: number[]) => kgRepository!.resolveScope(uid, folderIds)
    : undefined;
  const sessionSummary = new SessionSummaryService(sessions, messages, summaries, prompts);
  // Quiz AI orchestration: app-ts generates, app-quiz stores (internal key-auth route).
  // skills + ocr power 个性化出题（技能注入）与错题图片/文件出题（视觉转写）。
  // resume store = 断点续跑计划快照（自有库；Mongo 不可达降级进程内）。
  let quizResumeStore: QuizResumeStore = new MemoryQuizResumeStore();
  if (config.mongo.uri) {
    const mongoResume = await MongoQuizResumeStore.connect();
    if (mongoResume) quizResumeStore = mongoResume;
    else log.warn("[BOOT] quiz resume plans: memory fallback (mongodb unreachable)");
  }
  // quota 必须注入 quizGen/quizGrade：会员档位限额（config quota.limits 的
  // generate/grade/ocr）只在注入 QuotaService 后生效；缺省会静默回落 app-quiz
  // 的单档旧端点——付费会员在出题/批改/错题图片出题上被按 free 档限额，
  // 而 /quota/summary 与权益对照表仍展示 VIP/SVIP 额度（口径不一致）。
  const quizGen = new QuizGenerationService({
    summaries: sessionSummary,
    appQuiz: appQuizClient,
    rag,
    resolveFolderScope,
    prompts,
    skills: skillManager
      ? { forcedSection: (uid, ids) => skillManager!.forcedSection(uid, ids) }
      : undefined,
    ocr,
    // 模型能力注册表：quizModel 确认支持视觉 → 错题图片原图直读（免 OCR 转写）；
    // 能力未知/文本档 → OCR 兜底。与路由层 /chat 的视觉闸门同一数据源。
    capabilities,
    resumeStore: quizResumeStore,
    quota,
  });
  const quizGrade = new QuizGradingService({ appQuiz: appQuizClient, quota });
  // 2.85 Blindspot map (AI attribution): scope from app-bili, graph via
  //      app-kg gRPC, quiz signals via app-quiz; probed names from the
  //      app-ts's own chat history.
  let blindspot: BlindspotService | undefined;
  if (kgService && kgRepository) {
    const recentUserTexts = sessions instanceof MongoChatStore
      ? (uid: string, limit: number) => sessions.recentUserTexts(uid, limit)
      : async () => [] as string[];
    blindspot = new BlindspotService({
      graph: kgRepository,
      index: kgIndex ?? null,
      embeddings: rag.embeddings,
      appBili,
      appQuiz: appQuizClient,
      quizGen,
      recentUserTexts,
    });
    log.info("[BOOT] blindspot service ready");
  }

  const app = await buildServer({
    chat, harness, rag, sessionDocs, capabilities, ocr, kg: kgService,
    chatStores: { sessions, messages },
    chatImages,
    quota,
    ledger: usageLedger,
    recon: reconJob,
    resolveFolderScope,
    boardCompletion,
    summaries: sessionSummary,
    quizGen,
    quizGrade,
    vectorizer: config.vectorize.enabled ? vectorizer : undefined,
    appBili,
    taskQuiz: config.taskQuiz.enabled ? { generation: taskQuizGeneration, appTask, appAuth, quota } : undefined,
    blindspot,
    skills: skillManager && skillStore ? { manager: skillManager, store: skillStore } : undefined,
  });

  // 7. Redis event bridge: bili:page_ready → vectorization (no-op without REDIS__URL)
  const biliEvents = new BiliEventBridge(vectorizer);
  await biliEvents.start();

  // 8. 双账本对账 job（周期性，snapshot 进 /agent/runtime）
  reconJob.start();

  await app.listen({ host: config.server.host, port: config.server.port });
  log.info(`[BOOT] config layers: ${configSources.join(" -> ")}`);
  log.info(`[BOOT] app-ts listening on http://${config.server.host}:${config.server.port}`);
  log.info(`[BOOT] gateway=${config.aiGateway.baseUrl} milvus=${config.milvus.address}/${config.milvus.database}`);

  const shutdown = async (signal: string) => {
    log.info(`[BOOT] received ${signal}, shutting down`);
    await app.close();
    await rag.store.close();
    if (sessions instanceof MongoChatStore) {
      await sessions.close();
    }
    await mongoSessionDocs?.close();
    await mongoSummaries?.close();
    await mongoAgentContexts?.close();
    await kgRepository?.close();
    await mongoVecTasks?.close();
    await vecSources?.close();
    await mongoQuizDocs?.close();
    await (mongoSkillMeta instanceof MongoSkillMetaStore ? mongoSkillMeta.close() : Promise.resolve());
    await redisQuotaCounter?.close();
    await mongoUsageLedger?.close();
    reconJob.stop();
    await biliEvents.stop();
    await shutdownTracing();
    await closeLogger();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  installProcessErrorHandlers(log, shutdown);
}
