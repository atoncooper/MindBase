import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../../config/index.js";
import type { UsageLedgerRepository } from "../../../repository/usage-ledger.js";

/**
 * POST /internal/ai-usage — receiver for the Higress usage-logger Wasm plugin
 * The plugin fire-and-forgets one report
 * per /v1/* request: {request_id, uid, model, purpose, prompt_tokens,
 * completion_tokens, status}. Reports land in ai_gateway_usage as the GATEWAY
 * view, reconciled daily against the business-side ai_usage_daily rows.
 *
 * Reachability: the plugin posts inside the compose network (backendHost:
 * backend:8000) — this endpoint is NOT routed by APISIX. An optional shared
 * token (quota.gatewayUsageToken via X-Usage-Token) guards it when set.
 */
export function registerAiUsageRoutes(app: FastifyInstance, deps: { ledger: UsageLedgerRepository | null }): void {
  app.post("/internal/ai-usage", async (req: FastifyRequest, reply: FastifyReply) => {
    const expected = config.quota.gatewayUsageToken;
    if (expected && req.headers["x-usage-token"] !== expected) {
      return reply.status(401).send({ detail: "invalid usage token" });
    }
    if (!deps.ledger) return reply.status(204).send(); // ledger unavailable → accept and drop
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestId = typeof body.request_id === "string" ? body.request_id : "";
    if (!requestId) {
      return reply.status(400).send({ detail: "request_id required" });
    }
    const uidRaw = body.uid;
    const uid = typeof uidRaw === "string" && uidRaw !== "null" && /^\d+$/.test(uidRaw) ? uidRaw : undefined;
    await deps.ledger.recordGatewayReport({
      requestId,
      uid,
      model: typeof body.model === "string" ? body.model : "",
      purpose: typeof body.purpose === "string" ? body.purpose : "gateway",
      promptTokens: Number(body.prompt_tokens) || 0,
      completionTokens: Number(body.completion_tokens) || 0,
      status: typeof body.status === "string" ? body.status : "request",
      receivedAt: Date.now(),
    });
    return reply.status(204).send();
  });
}
