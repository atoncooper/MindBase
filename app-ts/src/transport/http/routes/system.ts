import type { FastifyInstance } from "fastify";
import type { AgentHarness } from "../../../harness/app.js";
import type { RAGService } from "../../../rag/service.js";
import type { ModelCapabilityRegistry } from "../../../llm/model-capabilities.js";
import { timeoutManager } from "../../../tools/timeout-manager.js";
import { admissionStatus } from "../../../services/admission.js";
import { mcpClientStats } from "../../../mcp/index.js";
import { config } from "../../../config/index.js";
import type { QuotaService } from "../../../services/quota.js";
import type { UsageReconciliationJob } from "../../../services/usage-reconciliation.js";
import { trackedTurns } from "../../../utils/degrade.js";

/**
 * System/ops routes: health, agent runtime status, model capabilities.
 * Reads-only, admin-facing; no business orchestration here.
 */
export function registerSystemRoutes(
  app: FastifyInstance,
  deps: {
    rag: RAGService;
    harness: AgentHarness;
    capabilities: ModelCapabilityRegistry;
    quota?: QuotaService;
    recon?: UsageReconciliationJob | null;
  },
): void {
  app.get("/health", async () => {
    const stats = await deps.rag.getCollectionStats();
    return {
      status: "ok",
      milvus: {
        available: stats.available,
        collection: stats.collectionName,
        totalChunks: stats.totalChunks,
        cloud: { available: stats.cloudAvailable, collection: stats.cloudCollectionName, chunks: stats.cloudChunks },
      },
    };
  });

  app.get("/agent/runtime", async () => ({
    uptime_s: Math.floor(process.uptime()),
    ...deps.harness.runtimeStatus(),
    timeouts: { active: timeoutManager.list(), running: timeoutManager.size },
    admission: admissionStatus(),
    mcp: mcpClientStats(),
    quota: {
      enabled: config.quota.enabled,
      costGuardEnabled: config.quota.costGuardEnabled,
      limits: config.quota.limits,
      trackedTurns: trackedTurns(),
      ...(deps.recon?.snapshot() ? { lastReconciliation: deps.recon!.snapshot() } : {}),
    },
  }));

  // Model capability view: vision/tool-calls for the configured model + registry health
  app.get("/agent/models", async () => {
    const current = config.llm.model;
    return {
      current: { model: current, ...deps.capabilities.get(current) },
      known_openrouter_models: deps.capabilities.known,
      metadata_stale: deps.capabilities.stale,
      overrides: Object.keys(JSON.parse(config.openrouter.overridesJson) as Record<string, unknown>),
    };
  });
}
