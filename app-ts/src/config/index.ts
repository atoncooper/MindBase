import { loadConfigFiles } from "./loader.js";

/**
 * Typed application config. The single source of truth for VALUES is the layered
 * YAML (config/default.yaml → config.yaml → local.yaml → env); this file owns the
 * TYPE (mirroring Python's pydantic sections) plus derived fields that YAML cannot
 * express. Secrets never live here — YAML references them via ${VAR} placeholders.
 */

export interface AppConfig {
  server: { host: string; port: number };
  redis: {
    /** pub/sub for bili:page_ready (per-page vectorization trigger); empty = no subscriber */
    url: string;
  };
  appBili: {
    /** acquisition service (Go): ASR delegation + read-only knowledge scope */
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    cacheTtlMs: number;
  };
  appTask: {
    /** app-task scheduler service (task register / email / completion callbacks) */
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  };
  appAuth: {
    /** auth service internal user lookup (email resolution for task delivery) */
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  };
  appUserSettings: {
    /** settings listener of app-user: Coding Plan M2M face (/internal/settings/coding-plan/{uid}) */
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  };
  appCloud: {
    /** cloud-drive service internal face (/internal/cloud/*, apikey-guarded) */
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  };
  taskQuiz: {
    /** false = /task-quiz/* + /internal/quiz/generate-llm not served */
    enabled: boolean;
    /** shared Mongo database holding the task_quiz_questions collection */
    sourceDatabase: string;
    docCollection: string;
    /** executor_url handed to app-task (via APISIX key-auth internal route) */
    executorUrl: string;
    /** structured-output retries for the generation LLM call */
    genRetries: number;
  };
  minio: {
    /** object storage for skill zips; empty endpoint = skills subsystem disabled */
    endpoint: string;
    /** optional base prefixed to chat-image display URLs (/minio-proxy/…);
     * empty = same-origin relative (nginx serves /minio-proxy/ on the app origin) */
    publicEndpoint: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
    secure: boolean;
  };
  skills: {
    /** false = /skills/* + load_skill not served (no storage) */
    enabled: boolean;
    storeApiUrl: string;
    storeTopic: string;
    storeApiKey: string;
  };
  vectorize: {
    /** false = per-page vectorization pipeline + /vec/page/* not served */
    enabled: boolean;
    /** pipeline tasks running concurrently */
    concurrency: number;
    /** total budget for delegated ASR (transcribe + poll margin) */
    asrTimeoutMs: number;
    pollIntervalMs: number;
  };
  aiGateway: {
    baseUrl: string;
    nativeBaseUrl: string; // derived: baseUrl with trailing /v1 → /api/v1 (rerank etc.)
    apiKey: string;
  };
  llm: { model: string; /** 后台结构化任务(quiz 出题等)模型:glm flash 对长中文 JSON Schema 遵循度差 */ quizModel: string; temperature: number };
  embedding: { model: string; dimension: number; batchSize: number };
  rerank: {
    enabled: boolean;
    model: string;
    timeoutMs: number;
    topN: number;
    minRelevanceScore: number;
  };
  milvus: {
    address: string;
    token: string;
    database: string;
    collection: string;
    /** cloud-drive collection searched in parallel (requires its own ingestion) */
    cloudCollection: string;
    /** sparse BM25 + dense dual-path retrieval (Milvus 2.5+; schema changes when toggled) */
    hybridSearch: boolean;
    dimension: number;
    indexType: string;
    metricType: string;
    nlist: number;
    nprobe: number;
    useMonthlyPartitions: boolean;
  };
  mongo: {
    uri: string;
    database: string;
    timeoutMs: number;
    /** Mongo ORM implementation for adapters that opt in (MikroORM pilot). */
    orm: "mikro" | "driver";
    sessionsCollection: string;
    messagesCollection: string;
  };
  toolsStub: {
    /** false = list_videos/get_video_summaries not registered (VideoMetaRepository is a stub) */
    videoMeta: boolean;
  };
  appPay: {
    /** membership tier lookup via APISIX key-auth internal route (app-pay) */
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    cacheTtlMs: number;
  };
  appQuiz: {
    /** app-quiz storage writes via the APISIX key-auth internal route (/internal/quiz/*) */
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  };
  kg: {
    /** false = kg_search tool + /knowledge/kg/* routes not registered (graceful degradation) */
    enabled: boolean;
    /** entity-vector collection inside the mind_base_ts Milvus database */
    collectionName: string;
    extractModel: string;
    maxTextChars: number;
    seedTopN: number;
    linkScoreThreshold: number;
    maxHops: number;
    expandLimitPerHop: number;
    evidenceLimit: number;
    concurrency: number;
    pageBatchSize: number;
    /** ASR transcript source — the Python backend's Mongo database (cross-DB read-only by design) */
    sourceDatabase: string;
    sourceCollection: string;
    /** cloud-doc build: max documents per build (paging stops at this cap) */
    cloudMaxDocs: number;
    /** cloud-doc listing page size for GET /internal/cloud/kg/documents (service caps at 100) */
    cloudListPageSize: number;
  };
  kgGrpc: {
    /** false = KG capability fully disabled (app-kg not deployed) */
    enabled: boolean;
    /** host:port of the app-kg gRPC data face */
    target: string;
    /** path to the shared proto/kg/v1/kg.proto (loaded at runtime, no codegen) */
    protoPath: string;
    timeoutMs: number;
  };
  contentMcp: {
    /**
     * Content-domain MCP (plan/1.0.20): one merged server (app-content-mcp) exposes
     * the 12 board+note+quiz tools behind a single /mcp endpoint.
     * false = NO tool of any of the three domains is registered (graceful
     * degradation when app-content-mcp is not deployed).
     */
    enabled: boolean;
    /** app-content-mcp streamable-http endpoint */
    url: string;
    /** service-mode apikey (uid rides the per-call X-Uid header, never LLM args) */
    apiKey: string;
    /** external-host Bearer token (alternative to apiKey) */
    bearerToken: string;
    timeoutMs: number;
    /** per-tool LLM context budget for bridged MCP tool output (truncation ceiling) */
    maxContentChars: number;
    /** optional model override for /chat/board/complete; empty = llm.model */
    completionModel: string;
  };
  sandbox: {
    /**
     * Code execution: false = run_code uses the Noop port
     * (honest "not executed" degradation); true = remote app-sandbox control plane.
     */
    enabled: boolean;
    /** app-sandbox control-plane base URL (APISIX key-auth internal route) */
    baseUrl: string;
    /** shared M2M key (apikey for APISIX + X-API-Key for app-sandbox) */
    apiKey: string;
    /** local deadline for create+poll (ms) */
    timeoutMs: number;
    /** execution-status poll interval (ms) */
    pollIntervalMs: number;
  };
  search: { defaultK: number };
  web: {
    maxBytes: number;
    maxRedirects: number;
    userAgent: string;
    /** politeness: min gap between requests to the same host */
    perHostIntervalMs: number;
    /** 联网搜索源（引擎链按序：deepseek → tavily → searxng → baidu → bing）。无任何配置时只剩爬虫兜底（质量不可靠） */
    searchTavilyApiKey: string;
    searchSearxngUrl: string;
    /** DeepSeek 官方搜索/抓取 API key（api-docs.deepseek.com/zh-cn/guides/search）；空 = 不接入 */
    deepseekApiKey: string;
    /** DeepSeek Search/Fetch 基址（可指向网关/代理） */
    deepseekApiBaseUrl: string;
    /** fetch_webpage 默认走 DeepSeek Fetch API（云端代抓 Markdown），失败回退本地抓取；false = 本地先行 */
    deepseekFetchPrimary: boolean;
  };

  tools: {
    /** budget when the model omits timeoutMs */
    defaultTimeoutMs: number;
    /** clamp floor — prevents 0/near-0 budgets */
    minTimeoutMs: number;
    /** clamp ceiling — the manager never honors more than 1 hour */
    maxTimeoutMs: number;
    /** global concurrent tool executions (protects Milvus/Mongo/gateway from fan-out) */
    maxConcurrent: number;
    /** bounded wait for a free slot before failing fast */
    queueWaitMs: number;
    /** consecutive failures/timeouts → tool breaker opens */
    breakerThreshold: number;
    /** cooldown before the breaker half-opens a probe call */
    breakerCooldownMs: number;
  };
  agent: {
    maxSteps: number;
    /** Per-agent ReAct step budget overrides (missing → maxSteps). */
    maxStepsByAgent: Record<string, number>;
    routingTimeoutMs: number;
    circuitFailureThreshold: number;
    circuitCooldownMs: number;
    /** turn-level retries for retryable failures (reset + fresh attempt) */
    turnRetries: number;
    /** same tool + same args rejected on the Nth identical call within one turn */
    toolRepeatLimit: number;
    /** whole-turn deadline (ms): a stalled LLM stream can never keep a turn alive forever */
    turnTimeoutMs: number;
    /** planner/supervisor DAG execution (custom ReAct agents + topological scheduling) */
    plan: {
      enabled: boolean;
      maxAgents: number;
      maxNodes: number;
      maxConcurrency: number;
      customAgentMaxSteps: number;
      nodeTimeoutMs: number;
      reflectAttempts: number;
      reflectTimeoutMs: number;
      maxDepth: number;
      allowedTools: string[];
    };
  };
  scheduling: {
    /** turn-level weighted admission queue for chat (services/admission.ts) */
    enabled: boolean;
    /** chat turns executing at once */
    maxConcurrent: number;
    /** waiting queue capacity — a full queue rejects immediately */
    queueMaxSize: number;
    /** queue wait ceiling before the turn errors out */
    queueTimeoutMs: number;
    /** dequeue priority by membership tier (svip > vip > free), FIFO within a tier */
    tierWeights: Record<string, number>;
    /** effective weight grows by agingStep per agingWindowMs of waiting (anti-starvation) */
    agingWindowMs: number;
    agingStep: number;
    /** interval between SSE queue-progress frames while waiting */
    queueFrameIntervalMs: number;
  };
  chunk: { targetSize: number; minSize: number; maxSize: number; overlap: number };
  log: { level: string; fileEnabled: boolean; dir: string; fileName: string };
  rateLimit: { windowMs: number; max: number };
  quota: {
    /** false = 配额门整体跳过（放行）；计数与账本照常 */
    enabled: boolean;
    /** kind → { free, vip, svip } 每日次数上限；-1 = 不限 */
    limits: Record<string, { free: number; vip: number; svip: number }>;
    /** Free 聊天 L0 条数（其后 L1 省流，硬停于 limits.chat.free） */
    freeLadder: { l0Turns: number };
    /** L1 省流的单轮输出 token 预算（0 = 不设限） */
    l1MaxOutputTokens: number;
    /** 当日累计成本软阈值（微元）→ L1 降级；0 = 关闭 */
    costSoftMicroYuan: Record<string, number>;
    /** 成本熔断：开关 + 各档阈值（微元） */
    costGuardEnabled: boolean;
    costGuardMicroYuan: Record<string, number>;
    /** 双账本对账周期（毫秒；0 = 关闭） */
    reconIntervalMs: number;
    /** 模型单价（元/百万 token） */
    prices: Record<string, { input: number; output: number }>;
    usageDailyCollection: string;
    gatewayUsageCollection: string;
    /** /internal/ai-usage 可选共享令牌（空 = 不校验，仅内网可达） */
    gatewayUsageToken: string;
  };
  prompts: { dir: string };
  context: { compressThreshold: number; recentKeep: number };
  timezone: { name: string };
  langsmith: {
    /** tracing via OTLP → LangSmith; missing apiKey = disabled (zero overhead) */
    apiKey: string;
    projectName: string;
    baseUrl: string;
  };
  openrouter: {
    modelsUrl: string;
    refreshHours: number;
    timeoutMs: number;
    overridesJson: string;
  };
  academic: {
    /**
     * Master switch for the academic workspace: false = the three
     * academic tools are not registered and the academic sub-agent is not created,
     * so delegate_to_agent reports it as unavailable (graceful degradation).
     */
    enabled: boolean;
    literature: {
      /** Crossref REST base URL — primary search source, and the only authority used for DOI verification. */
      crossrefBaseUrl: string;
      /** OpenAlex REST base URL — fallback used when Crossref errors or maps to zero hits. */
      openalexBaseUrl: string;
      /** arXiv Atom API base URL — preprint search only; never used to verify a DOI. */
      arxivBaseUrl: string;
      /** Per-request deadline for literature HTTP calls (an independent budget, not the shared tool timeout). */
      timeoutMs: number;
      /** polite-pool contact for Crossref/OpenAlex; empty = no contact param */
      mailto: string;
      /** per-query result cap (1-25 enforced by the client) */
      maxResults: number;
    };
  };
  ocr: {
    enabled: boolean;
    model: string;
    apiKey: string;
    prompt: string;
    maxImageBytes: number;
    timeoutMs: number;
  };
}

const loaded = loadConfigFiles();

export const configSources: string[] = loaded.sources;

export const config: AppConfig = (() => {
  const raw = loaded.value as unknown as AppConfig;
  // derived field: native (non-OpenAI) gateway surface, env can override explicitly
  raw.aiGateway.nativeBaseUrl =
    process.env.AI_GATEWAY__NATIVE_BASE_URL ??
    raw.aiGateway.baseUrl.replace(/\/v1\/?$/, "") + "/api/v1";
  return raw;
})();
