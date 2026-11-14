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
import { createPlanAndRunTool } from "../tools/harness/plan-graph.js";
import { PlanRunner } from "../agent/dag/runner.js";
import { PlanRunEngine } from "../agent/dag/state.js";
import { MemoryPlanRunRepository } from "../repository/memory/plan-runs.js";
import { MongoPlanRunRepository } from "../repository/mongo/plan-runs.js";
import type { PlanRunRepository } from "../repository/plan-runs.js";
import { ReflectService } from "../agent/dag/reflect.js";
import {
  createRenderChartTool,
  createRenderComparisonTool,
  createRenderDiagramTool,
  createRenderPlotTool,
} from "../tools/render/index.js";
import { createFetchWebpageTool } from "../tools/web/fetch-page.js";
import { createWebSearchTool } from "../tools/web/search.js";
import {
  createCloudDocSummaryTool,
  createCloudSemanticSearchTool,
  createCloudSimilarFilesTool,
} from "../tools/cloud/index.js";
import { createFetchPortWithDeepseekPrimary } from "../tools/web/deepseek.js";
import { HttpWebFetch } from "../tools/web/fetcher.js";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import { AgentLifecycleManager } from "../agent/lifecycle.js";
import { PromptRegistry } from "../agent/prompts/loader.js";
import { SUB_AGENTS } from "../agent/manifest.js";
import { createMainAgent } from "../agent/main/agent.js";
import { createNoteAgent } from "../agent/note/agent.js";
import { createCodeAgent } from "../agent/code/agent.js";
import { createCodingPlanResolver } from "../agent/code/coding-plan-resolver.js";
import { createQuizAgent } from "../agent/quiz/agent.js";
import { createBoardAgent } from "../agent/board/agent.js";
import { createAcademicProjectTool } from "../tools/academic/project.js";
import { createAcademicLiteratureTool } from "../tools/academic/literature.js";
import { createAcademicManuscriptTool } from "../tools/academic/manuscript.js";
import { createLiteratureClient } from "../clients/literature-client.js";
import { AcademicService } from "../services/academic.js";
import { ResearchWorkspaceService } from "../services/research-workspace.js";
import { ManuscriptDocxService } from "../services/manuscript-docx.js";
import { MemoryResearchWorkspaceRepository } from "../repository/memory/research-workspaces.js";
import { MongoResearchWorkspaceRepository } from "../repository/mongo/research-workspaces.js";
import type { ResearchWorkspaceRepository } from "../repository/research-workspaces.js";
import { createResearchWorkspaceTool } from "../tools/academic/workspace.js";
import { ResearchExperimentRunner } from "../services/research-experiment.js";
import { MemoryResearchExperimentRepository } from "../repository/memory/research-experiments.js";
import { MongoResearchExperimentRepository } from "../repository/mongo/research-experiments.js";
import type { ResearchExperimentRepository } from "../repository/research-experiments.js";
import { createAcademicExperimentTool } from "../tools/academic/experiment.js";
import { ResearchValidationService } from "../services/research-validation.js";
import { createAcademicValidationTool } from "../tools/academic/validation.js";
import { ResearchAnalysisService } from "../services/research-analysis.js";
import { createAcademicAnalysisTool } from "../tools/academic/analysis.js";
import { ResearchApprovalService } from "../services/research-approval.js";
import { MemoryResearchApprovalRepository } from "../repository/memory/research-approvals.js";
import { MongoResearchApprovalRepository } from "../repository/mongo/research-approvals.js";
import type { ResearchApprovalRepository } from "../repository/research-approvals.js";
import { createResearchApprovalTool } from "../tools/academic/approval.js";
import { createAcademicEvidenceTool } from "../tools/academic/evidence.js";
import { MemoryAcademicEvidenceStore } from "../repository/memory/academic-evidence.js";
import { MongoAcademicEvidenceStore } from "../repository/mongo/academic-evidence.js";
import type { AcademicEvidenceRepository } from "../repository/academic-evidence.js";
import { MikroAcademicEvidenceStore } from "../repository/mongo/mikro/academic-evidence.js";
import { MemoryAcademicStore } from "../repository/memory/academic.js";
import { MongoAcademicStore } from "../repository/mongo/academic.js";
import { AgentHarness } from "../harness/app.js";
import { ChatService } from "../services/chat.js";
import { buildAcademicSystemSection } from "../services/academic-context.js";
import { BoardCompletionService } from "../services/board-completion.js";
import { SessionSummaryService } from "../services/session-summary.js";
import { QuizGenerationService } from "../services/quiz-generation.js";
import { QuizGradingService } from "../services/quiz-grading.js";
import { AppQuizClient } from "../clients/app-quiz-client.js";
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
import { MongoMemoryStore } from "../repository/mongo/memory-store.js";
import type { MemoryRepository } from "../repository/memory-store.js";
import { NoopCodeExecution } from "../tools/code/code-execution.js";
import { HttpCodeExecution } from "../tools/code/http-execution.js";
import { createSandboxBashTool, createSandboxGrepTool, createSandboxPwshTool } from "../tools/code/shell.js";
import { MemorySessionDocumentStore } from "../repository/memory/session-docs.js";
import { GrpcKgGraphRepository } from "../repository/app-kg/kg-graph.js";
import { MemoryKgGraphRepository } from "../repository/memory/kg-graph.js";
import { MemoryKgSourceStore } from "../repository/memory/kg-sources.js";
import { MongoKgSourceStore } from "../repository/mongo/kg-sources.js";
import { MemoryKgBuildStore } from "../repository/memory/kg-builds.js";
import { MongoKgBuildStore } from "../repository/mongo/kg-builds.js";
import { HttpKgCloudSourceStore } from "../repository/app-cloud/kg-cloud-sources.js";
import { MemoryKgDocStore } from "../repository/memory/kg-docs.js";
import { MongoKgDocStore } from "../repository/mongo/kg-docs.js";
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
import { AppUserBiliClient } from "../clients/app-user-bili-client.js";
import { VideoVectorizerService } from "../services/video-vectorizer.js";
import { BiliEventBridge } from "../bootstrap/redis-events.js";
import { AppTaskClient } from "../clients/app-task-client.js";
import { AppUserAuthClient } from "../clients/app-user-auth-client.js";
import { AppCloudClient } from "../clients/app-cloud-client.js";
import { DocxInspectService } from "../services/docx-inspect.js";
import { TempWorkspaceManager } from "../context/temp-workspace.js";
import { createDocxInspectTool } from "../tools/docx/inspect.js";
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
 * Board tools bridged dynamically from the merged content MCP server
 * (app-content-mcp). Only these 6 are bridged: save_note / save_quiz /
 * save_grading live on the SAME server but have handwritten wrappers, so
 * bridging every discovered tool would collide on names and double-register
 * their schemas.
 */
const CONTENT_MCP_BOARD_TOOL_NAMES = [
  "list_boards",
  "get_board",
  "create_board",
  "update_board",
  "pin_board",
] as const;

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
  const appBili = new AppUserBiliClient();
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
  // app-user exposes two M2M faces on two listeners: auth (8006, email lookup)
  // and settings (8015, Coding Plan — user configuration, not identity).
  const appAuth = new AppUserAuthClient({
    baseUrl: config.appAuth.baseUrl,
    apiKey: config.appAuth.apiKey,
    timeoutMs: config.appAuth.timeoutMs,
    settingsBaseUrl: config.appUserSettings.baseUrl,
    settingsApiKey: config.appUserSettings.apiKey,
    settingsTimeoutMs: config.appUserSettings.timeoutMs,
  });
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
  // Long-term memory: Mongo keeps save_memory durable across restarts; memory
  // only when Mongo is unreachable/unconfigured (logs an explicit warning —
  // silently dropping memories on restart is a data-loss bug, not a fallback).
  let memoryStore: MemoryRepository = new MemoryMemoryStore();
  let mongoMemoryStore: MongoMemoryStore | null = null;
  if (config.mongo.uri) {
    mongoMemoryStore = await MongoMemoryStore.connect();
    if (mongoMemoryStore) {
      memoryStore = mongoMemoryStore;
      log.info(`[BOOT] long-term memory: mongodb db=${config.mongo.database} collection=memory_entries`);
    } else {
      log.warn("[BOOT] long-term memory: memory fallback (mongodb unreachable) — memories are lost on restart");
    }
  } else {
    log.warn("[BOOT] long-term memory: memory fallback (MONGO__URI not set) — memories are lost on restart");
  }
  registry.register(createSaveMemoryTool(memoryStore));
  registry.register(createAskUserTool);
  // Interactive artifacts: declarative plot/diagram/chart/comparison specs
  // rendered by the web client with trusted components (no HTML/JS from the
  // model, no iframe).
  registry.register(createRenderPlotTool());
  registry.register(createRenderDiagramTool());
  registry.register(createRenderChartTool());
  registry.register(createRenderComparisonTool());
  const webFetch = createFetchPortWithDeepseekPrimary(new HttpWebFetch());
  registry.register(createFetchWebpageTool(webFetch));
  registry.register(createWebSearchTool());
  // Cloud-drive document intelligence: summary / semantic search / similar files
  // are read from app-cloud's existing endpoints (apikey + X-Uid). The tools are
  // registered unconditionally so a deployment without app-cloud answers with an
  // explicit "not configured" notice instead of silently losing the capability
  // from the agent roster.
  const appCloud = new AppCloudClient();
  registry.register(createCloudDocSummaryTool(appCloud));
  registry.register(createCloudSemanticSearchTool(appCloud));
  registry.register(createCloudSimilarFilesTool(appCloud));
  if (appCloud.configured) {
    log.info(
      `[BOOT] cloud tools registered: cloud_doc_summary / cloud_semantic_search / cloud_similar_files (app-cloud ${config.appCloud.baseUrl})`,
    );
  } else {
    log.warn(
      "[BOOT] app-cloud not configured (APP_CLOUD_BASE_URL / APISIX_CONSUMER_KEY) — " +
        "cloud tools will answer with a not-configured notice",
    );
  }

  // Local temp files for agent-side parsing (docs/temp-files.md): documents are
  // downloaded into a per-(uid, turn) directory, parsed from disk, and deleted by
  // ChatService when the whole turn ends. Tools can create files but never delete
  // them; a startup sweep cleans crash residue.
  const tempWorkspaces = new TempWorkspaceManager({
    enabled: config.tempFiles.enabled,
    baseDir: config.tempFiles.dir,
    maxFilesPerTurn: config.tempFiles.maxFilesPerTurn,
    maxBytesPerTurn: config.tempFiles.maxBytesPerTurn,
    maxFileBytes: config.tempFiles.maxFileBytes,
    maxGlobalFiles: config.tempFiles.maxGlobalFiles,
    maxConcurrentWrites: config.tempFiles.maxConcurrentWrites,
    staleTtlMs: config.tempFiles.staleTtlMs,
    sweepIntervalMs: config.tempFiles.sweepIntervalMs,
  });
  await tempWorkspaces.start();

  // Word (docx) detail inspection (docx_inspect): level-1 section extraction stays
  // server-side (manuscript import), this second-level tool lets the agent read
  // page setup / styles / table merges / headers from the ORIGINAL package. It
  // reuses the same conversation-upload + cloud-drive ports as the manuscript
  // tool, so both sources resolve through one path; tempFiles only sees the
  // create-only capability (materialize) and never the disposal API.
  const docxInspect = new DocxInspectService({
    sessionDocs,
    sessionFiles: chatImages,
    cloud: appCloud,
    tempFiles: tempWorkspaces,
  });
  registry.register(createDocxInspectTool(docxInspect));
  log.info("[BOOT] docx_inspect tool registered (docx detail inspection)");

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
    // Cloud-doc KG source: app-cloud M2M face when configured, else null
    // (cloud builds answer 503 instead of silently building nothing).
    const cloudSources = appCloud.configured ? new HttpKgCloudSourceStore(appCloud) : null;
    if (!cloudSources) {
      log.warn("[BOOT] app-cloud not configured — cloud-doc KG builds disabled (503)");
    }
    // Cloud-doc extraction ledger: idempotency key (uid, upload_uuid) → content hash
    const docStore =
      (config.mongo.uri ? await MongoKgDocStore.connect() : null) ?? new MemoryKgDocStore();
    if (docStore instanceof MemoryKgDocStore) {
      log.warn("[BOOT] kg doc ledger: memory fallback (cloud-doc idempotency is lost on restart)");
    }
    kgService = new KgService({
      graph,
      extractor,
      sources: sources ?? new MemoryKgSourceStore(),
      cloudSources,
      docs: docStore,
      builds: builds ?? new MemoryKgBuildStore(),
      index,
      embeddings: rag.embeddings,
    });
    registry.register(createKgSearchTool(new KgRetriever({ graph, index, embeddings: rag.embeddings })));
    log.info("[BOOT] kg_search tool registered");
  } else {
    log.info("[BOOT] kg disabled — kg_search tool and /knowledge/kg/* routes not registered");
  }
  // Content-domain MCP (plan/1.0.20): ONE merged server app-content-mcp exposes
  // board (6) + note (1) + quiz (2) tools on a single /mcp endpoint. A single
  // client (name="content") backs the hand-written note/quiz wrappers, the board
  // dynamic bridge and BoardCompletionService — auth headers are injected once
  // here; uid travels per-call as X-Uid.
  const contentMcpHeaders: Record<string, string> = {};
  if (config.contentMcp.bearerToken) contentMcpHeaders["Authorization"] = `Bearer ${config.contentMcp.bearerToken}`;
  // MCP server 服务模式认 APISIX 惯例的 `apikey` 头（serve.go: Header.Get("apikey")），
  // 不是 X-Api-Key——头名错位会被服务端当作未带凭证而 401
  if (config.contentMcp.apiKey) contentMcpHeaders["apikey"] = config.contentMcp.apiKey;
  const contentMcp = config.contentMcp.enabled
    ? new McpClient({
        name: "content",
        url: config.contentMcp.url,
        timeoutMs: config.contentMcp.timeoutMs,
        defaultHeaders: contentMcpHeaders,
      })
    : null;
  if (contentMcp) {
    log.info(`[BOOT] content MCP client ready (${config.contentMcp.url})`);
  } else {
    log.info("[BOOT] content MCP disabled — note/quiz/board tools not registered");
  }
  // Note saving: goes through app-content-mcp (save_note) — never the note tables directly.
  if (contentMcp) {
    registry.register(createSaveNoteTool(contentMcp));
    log.info("[BOOT] note MCP tool registered (save_note; content MCP)");
  } else {
    log.info("[BOOT] note MCP disabled — save_note not registered");
  }
  // Code execution: the composition root is the only place
  // that decides remote vs stub. Enabled = app-sandbox control plane (HTTP +
  // X-Uid); otherwise the Noop port keeps the honest "not executed" answer.
  const codeExec = config.sandbox.enabled
    ? new HttpCodeExecution({
        baseUrl: config.sandbox.baseUrl,
        apiKey: config.sandbox.apiKey,
        timeoutMs: config.sandbox.timeoutMs,
        pollIntervalMs: config.sandbox.pollIntervalMs,
      })
    : new NoopCodeExecution();
  registry.register(createRunCodeTool(codeExec));
  registry.register(createSandboxBashTool(codeExec));
  registry.register(createSandboxPwshTool(codeExec));
  registry.register(createSandboxGrepTool(codeExec));
  log.info(`[BOOT] run_code tool registered (store=${config.sandbox.enabled ? "remote" : "stub"})`);
  // Quiz generation: the quiz agent authors questions; persistence goes through
  // app-content-mcp (save_quiz / save_grading) — never the quiz tables directly.
  if (contentMcp) {
    registry.register(createEmitQuizTool(contentMcp));
    registry.register(createEmitGradingTool(contentMcp));
    log.info("[BOOT] quiz MCP tools registered (emit_quiz/emit_grading; content MCP)");
  } else {
    log.info("[BOOT] quiz MCP disabled — quiz tools not registered");
  }
  // 3.9 Academic research workspace: research projects, the
  //     literature library and manuscript documents.
  //     Store selection happens HERE and only here (composition root, per
  //     app-ts/AGENTS.md section 3): Mongo (mind_base_ts academic_*) is the durable
  //     choice, picked only when a Mongo URI is configured AND connect() succeeds.
  //     Any other outcome degrades to the in-process MemoryAcademicStore so the
  //     agent stays usable — that fallback loses every research record on restart,
  //     which is why it is warned about explicitly (silent loss would be a data bug).
  //     mongoAcademic is declared outside the branch only because shutdown needs it.
  let mongoAcademic: MongoAcademicStore | null = null;
  let mongoAcademicEvidence: MongoAcademicEvidenceStore | MikroAcademicEvidenceStore | null = null;
  let academicService: AcademicService | undefined;
  let academicEvidence: AcademicEvidenceRepository | undefined;
  let researchWorkspaceService: ResearchWorkspaceService | undefined;
  let manuscriptDocxService: ManuscriptDocxService | undefined;
  let researchApprovals: ResearchApprovalService | undefined;
  let experimentRunner: ResearchExperimentRunner | undefined;
  // validation/analysis are also consumed by the HTTP research surface below;
  // declared here (outside the branch) so buildServer can receive them.
  let researchValidation: ResearchValidationService | undefined;
  let researchAnalysis: ResearchAnalysisService | undefined;
  if (config.academic.enabled) {
    mongoAcademic = config.mongo.uri ? await MongoAcademicStore.connect() : null;
    if (!mongoAcademic) {
      log.warn("[BOOT] academic store: memory fallback (mongodb unreachable/unconfigured) — research data is lost on restart");
    }
    // One adapter instance backs all three tools: projects/literature/documents/
    // events are separate contracts over the same record model, so sharing it keeps
    // the three tool views consistent by construction.
    const academic = mongoAcademic ?? new MemoryAcademicStore();
    // The only literature network client; built here (not inside the tool) so the
    // injectable fetch/timeout stay a composition-root concern.
    const literatureClient = createLiteratureClient();
    // Registration must happen before the HTTP server accepts traffic: the agent
    // runtime resolves tool names per invocation and silently skips unknown ones,
    // so a missing registration degrades into an agent with fewer tools instead of
    // throwing. The academic agent itself is constructed in section 4 from the
    // manifest roster.
    registry.register(
      createAcademicProjectTool({
        projects: academic,
        events: academic,
        literature: academic,
        documents: academic,
      }),
    );
    registry.register(createAcademicLiteratureTool({ literature: academic, projects: academic, events: academic, client: literatureClient }));
    // Evidence layer (datasets + analysis runs): durable in its own Mongo
    // collection (academic_runs); a failed connect degrades to the in-process store
    // with an explicit warning, same policy as the project store above.
    if (config.mongo.uri) {
      if (config.mongo.orm === "mikro") {
        mongoAcademicEvidence = await MikroAcademicEvidenceStore.connect();
        if (!mongoAcademicEvidence) {
          log.warn("[BOOT] MikroORM unavailable — falling back to the direct MongoDB driver");
        }
      }
      mongoAcademicEvidence ??= await MongoAcademicEvidenceStore.connect();
    }
    if (!mongoAcademicEvidence) {
      log.warn("[BOOT] academic evidence store: memory fallback (mongodb unreachable/unconfigured) — run records are lost on restart");
    }
    const evidence = mongoAcademicEvidence ?? new MemoryAcademicEvidenceStore();
    academicEvidence = evidence;
    registry.register(createAcademicEvidenceTool({ runs: evidence, projects: academic, events: academic }));
    researchValidation = new ResearchValidationService(academic, academic, academic, evidence);
    registry.register(createAcademicValidationTool(researchValidation));
    let approvalRepo: ResearchApprovalRepository = new MemoryResearchApprovalRepository();
    if (config.mongo.uri) {
      const mongoApprovals = await MongoResearchApprovalRepository.connect();
      if (mongoApprovals) approvalRepo = mongoApprovals;
      else log.warn("[BOOT] research approvals: memory fallback (mongodb unreachable)");
    }
    const approvalsService = new ResearchApprovalService(approvalRepo);
    researchApprovals = approvalsService;
    registry.register(createResearchApprovalTool(approvalsService));
    let workspaceRepo: ResearchWorkspaceRepository = new MemoryResearchWorkspaceRepository();
    if (config.mongo.uri) {
      const mongoWorkspaces = await MongoResearchWorkspaceRepository.connect();
      if (mongoWorkspaces) workspaceRepo = mongoWorkspaces;
      else log.warn("[BOOT] research workspaces: memory fallback (mongodb unreachable)");
    }
    const researchWorkspaces = new ResearchWorkspaceService(workspaceRepo, appCloud);
    researchWorkspaceService = researchWorkspaces;
    registry.register(createResearchWorkspaceTool(researchWorkspaces));
    // Word import/export (docs/manuscript-docx.md): renders .docx and round-trips
    // it through the project cloud drive (05_论文). Built here because it needs
    // both the cloud M2M client and the workspace folder mapping; the agent tool
    // and the /academic/* Word routes share this one instance.
    manuscriptDocxService = new ManuscriptDocxService({
      documents: academic,
      projects: academic,
      workspace: researchWorkspaces,
      cloud: appCloud,
    });
    registry.register(
      createAcademicManuscriptTool({
        documents: academic,
        projects: academic,
        events: academic,
        docx: manuscriptDocxService,
        // Conversation uploads → manuscript template: the Word a user uploaded
        // in chat keeps its original binary in attachment storage, so import_docx
        // can reuse it without asking for a second upload.
        sessionDocs,
        sessionFiles: chatImages,
      }),
    );
    const retentionTimer = setInterval(() => {
      void researchWorkspaces
        .cleanupTemporary(config.academic.retentionTempDays)
        .then((r) => {
          if (r.deleted > 0) log.info("[RETENTION] temporary research files deleted=" + r.deleted + " scanned=" + r.scanned);
        })
        .catch((err) => log.warn("[RETENTION] sweep failed: " + (err instanceof Error ? err.message : err)));
    }, Math.max(60_000, config.academic.retentionSweepMs));
    retentionTimer.unref();
    researchAnalysis = new ResearchAnalysisService(academic, evidence, academic, researchWorkspaces);
    registry.register(createAcademicAnalysisTool(researchAnalysis));
    let experimentRepo: ResearchExperimentRepository = new MemoryResearchExperimentRepository();
    if (config.mongo.uri) {
      const mongoExperiments = await MongoResearchExperimentRepository.connect();
      if (mongoExperiments) experimentRepo = mongoExperiments;
      else log.warn("[BOOT] research experiments: memory fallback (mongodb unreachable)");
    }
    experimentRunner = new ResearchExperimentRunner(experimentRepo, codeExec);
    experimentRunner.setArtifactSink(async (exp) => {
      if (!researchWorkspaceService || !academicEvidence) return;
      const files: Array<{ name: string; sizeBytes?: number; sha256?: string }> = [];
      const upload = async (name: string, content: string, mime = "text/plain; charset=utf-8") => {
        const result = await researchWorkspaceService!.uploadFile(
          exp.uid,
          exp.projectId,
          "results",
          name,
          new TextEncoder().encode(content),
          mime,
        );
        files.push({ name: result.name, sizeBytes: result.size, ...(result.sha256 ? { sha256: result.sha256 } : {}) });
      };
      // Date + experiment id prefix: temporary data is archived per experiment
      // batch, and multiple experiments never overwrite each other's logs.
      const batch = new Date(exp.createdAt).toISOString().slice(0, 10);
      const prefix = batch + "__" + exp.id + "__";
      await upload(prefix + "stdout.log", exp.stdoutPreview ?? "");
      await upload(prefix + "stderr.log", exp.stderrPreview ?? "");
      await upload(prefix + "experiment.json", JSON.stringify(exp, null, 2), "application/json");
      await academicEvidence!.recordRun(exp.uid, exp.projectId, {
        name: exp.title ?? ("experiment " + exp.id),
        language: exp.language,
        script: exp.code,
        ...(exp.status === "succeeded" || exp.status === "failed" || exp.status === "interrupted"
          ? { status: exp.status === "succeeded" ? "succeeded" : exp.status === "interrupted" ? "timed_out" : "failed" }
          : {}),
        ...(exp.exitCode !== undefined ? { exitCode: exp.exitCode } : {}),
        ...(exp.stdoutPreview ? { stdoutPreview: exp.stdoutPreview } : {}),
        ...(exp.stderrPreview ? { stderrPreview: exp.stderrPreview } : {}),
        artifacts: files,
        ...(exp.startedAt !== undefined ? { startedAt: exp.startedAt } : {}),
        ...(exp.endedAt !== undefined ? { finishedAt: exp.endedAt } : {}),
      });
    });
    registry.register(createAcademicExperimentTool(experimentRunner, academic, approvalsService));
    // One repository instance backs both the agent tools and the /academic/* REST
    // surface, so chat edits and the workbench UI observe the same state.
    academicService = new AcademicService({
      projects: academic,
      literature: academic,
      documents: academic,
      events: academic,
      client: literatureClient,
    });
    log.info(`[BOOT] academic tools registered (store=${mongoAcademic ? "mongodb" : "memory"})`);
  } else {
    // Nothing is registered, so section 4 does not create the academic sub-agent
    // either and delegate_to_agent reports it as unavailable.
    log.info("[BOOT] academic disabled — academic tools/agent not registered");
  }
  // MCP dynamic tool bridge (src/mcp/): the app-content-mcp server OWNS its
  // board tools — discovered via tools/list and registered verbatim. Only the
  // board 6 are bridged (includeToolNames): note/quiz wrappers above talk to the
  // same server, so bridging all 12 tools would collide on names.
  let boardCompletion: BoardCompletionService | undefined;
  if (contentMcp) {
    // discoveryUid="1"：service-mode 网关要求正整数 X-Uid（uid<=0 拒绝），boot
    // 发现无用户会话；tools/list 只返回工具元数据不触达上游，真实调用仍按会话
    // uid 走 X-Uid
    const registered = await registerMcpTools(registry, contentMcp, {
      maxContentChars: config.contentMcp.maxContentChars,
      discoveryUid: "1",
      includeToolNames: CONTENT_MCP_BOARD_TOOL_NAMES,
    });
    log.info(`[BOOT] board MCP tools registered: ${registered}/${CONTENT_MCP_BOARD_TOOL_NAMES.length} (content MCP)`);
    // /chat/board/complete reuses the same service-mode client (GET board + one
    // structured LLM call); route is registered only when this block ran.
    boardCompletion = new BoardCompletionService({
      client: contentMcp,
      completionModel: config.contentMcp.completionModel,
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

  // Planner/supervisor DAG: main agent can define custom ReAct agents and a
  // topological plan graph; each node executes through the same lifecycle.
  let planRuns: PlanRunRepository = new MemoryPlanRunRepository();
  if (config.mongo.uri) {
    const mongoPlanRuns = await MongoPlanRunRepository.connect();
    if (mongoPlanRuns) {
      planRuns = mongoPlanRuns;
      log.info("[BOOT] plan runs: mongodb");
    } else {
      log.warn("[BOOT] plan runs: memory fallback (mongodb unreachable)");
    }
  } else {
    log.warn("[BOOT] plan runs: memory fallback (MONGO__URI not set)");
  }
  const planEngine = new PlanRunEngine(planRuns);
  const planRunner = new PlanRunner({
    lifecycle,
    runtime,
    prompts,
    reflect: new ReflectService(prompts),
    engine: planEngine,
  });
  const planAllowedTools = config.agent.plan.allowedTools.filter(
    (name) => runtime.listToolDefs([name]).length > 0,
  );
  registry.register(createPlanAndRunTool(planRunner, SUB_AGENTS.map((a) => a.name), planAllowedTools));

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
  // Code agent only: route to the user's own Coding Plan when app-user has one
  // (VIP/SVIP, enabled) and the daily coding_plan quota allows it. Every
  // unavailable path (no plan / non-VIP / 404 / 403 / 503 / quota exhausted)
  // resolves undefined → the platform gateway model (fail-open).
  const codingPlanResolver = createCodingPlanResolver({ plans: appAuth, quota });
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
  // The workbench's "ask AI" link sends academic_project_id with the turn; this
  // resolver renders a controlled project section into the system prompt. A
  // missing/foreign project (or Mongo fallback) simply yields no section.
  const academicContextSection = academicService
    ? async (uid: string | undefined, projectId: string) => {
        if (uid === undefined) return undefined;
        try {
          const detail = await academicService!.getProject(uid, projectId);
          return buildAcademicSystemSection(prompts, {
            id: detail.project.id,
            title: detail.project.title,
            stage: detail.project.stage,
            literatureCount: detail.project.literatureCount,
            documentCount: detail.project.documentCount,
          });
        } catch {
          return undefined;
        }
      }
    : undefined;
  const chat = new ChatService(harness, sessions, messages, compression, (id, q) => {
    void generateTitle(sessions, prompts, id, q);
  }, admission, chatImages, quota, usageLedger, prompts, academicContextSection, (input) =>
    codingPlanResolver({ uid: input.uid, model: input.model }),
  tempWorkspaces,
  );
  // Experiment completion callback: continue the same chat session with a
  // synthetic AI turn instead of making the model poll the sandbox.
  experimentRunner?.setCallback(async (exp) => {
    if (!exp.chatSessionId) return;
    const prompt =
      "【实验回调】后台实验 " + exp.id + " 已 " + exp.status +
      "。" + (exp.stdoutPreview ? "\nstdout 预览：\n" + exp.stdoutPreview.slice(0, 4000) : "") +
      (exp.stderrPreview ? "\nstderr 预览：\n" + exp.stderrPreview.slice(0, 2000) : "") +
      (exp.error ? "\n错误：" + exp.error : "") +
      "\n请读取该实验的 evidence，分析结果并继续当前科研任务；不要轮询实验状态。";
    const stream = chat.askStream({
      query: prompt,
      uid: exp.uid,
      sessionId: exp.chatSessionId,
      agentName: "main",
    });
    for await (const _frame of stream) {
      // Drain frames: the chat service persists the assistant message; no SSE
      // client is attached to this background turn.
    }
  });
  await experimentRunner?.reconcileInterrupted();
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
  // 2.85 Blindspot map (AI attribution): scope from app-user, graph via
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
    academic: academicService,
    approvals: researchApprovals,
    manuscriptDocx: manuscriptDocxService,
    // research workbench REST (experiments/evidence/validation/analysis/workspace):
    // registered only when every service was actually assembled (academic on).
    research:
      academicService &&
      experimentRunner &&
      academicEvidence &&
      researchValidation &&
      researchAnalysis &&
      researchWorkspaceService
        ? {
            experiments: experimentRunner,
            evidence: academicEvidence,
            validation: researchValidation,
            analysis: researchAnalysis,
            workspace: researchWorkspaceService,
          }
        : undefined,
    // sandbox panel proxy: always wired (disabled still answers { enabled:false }).
    sandbox: {
      enabled: config.sandbox.enabled,
      baseUrl: config.sandbox.baseUrl,
      apiKey: config.sandbox.apiKey,
    },
    plans: { engine: planEngine, runner: planRunner },
    planMetrics: () => planRunner.stats(),
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
    // Whole-program cleanup of scratch files (any turn still unwinding loses its
    // directory deliberately: the process is stopping).
    await tempWorkspaces.close();
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
    await mongoMemoryStore?.close();
    // Release the academic Mongo client only when the durable store was actually
    // used; the memory fallback leaves mongoAcademic null, so this is a no-op there.
    await mongoAcademic?.close();
    await mongoAcademicEvidence?.close();
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
