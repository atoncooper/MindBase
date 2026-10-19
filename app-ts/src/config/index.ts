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
  noteMcp: {
    /** false = save_note tool not registered (note saving unavailable) */
    enabled: boolean;
    url: string;
    apiKey: string;
    bearerToken: string;
    timeoutMs: number;
  };
  quizMcp: {
    /** false = quiz tools not registered (quiz generation unavailable) */
    enabled: boolean;
    url: string;
    apiKey: string;
    bearerToken: string;
    timeoutMs: number;
  };
  boardMcp: {
    /** false = board tools not registered at boot (graceful degradation when app-board-mcp is not deployed) */
    enabled: boolean;
    url: string;
    apiKey: string;
    bearerToken: string;
    timeoutMs: number;
    /** optional model override for /chat/board/complete; empty = llm.model */
    completionModel: string;
    /** per-tool LLM context budget for bridged MCP tool output (truncation ceiling) */
    maxContentChars: number;
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
    routingTimeoutMs: number;
    circuitFailureThreshold: number;
    circuitCooldownMs: number;
    /** turn-level retries for retryable failures (reset + fresh attempt) */
    turnRetries: number;
    /** same tool + same args rejected on the Nth identical call within one turn */
    toolRepeatLimit: number;
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
