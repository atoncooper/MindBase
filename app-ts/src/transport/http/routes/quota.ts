import type { FastifyInstance, FastifyRequest } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";
import { hashClientKey, type QuotaService } from "../../../services/quota.js";

/**
 * GET /quota/summary — the signed-in user's (or the IP bucket's) unified token
 * usage: rolling 5-hour + day + month windows, per-kind breakdown, model
 * weights and the cost block. Consumed by the chat badge, the quota page and
 * the membership center.
 */
export function registerQuotaRoutes(app: FastifyInstance, deps: { quota: QuotaService }): void {
  app.get("/quota/summary", async (req: FastifyRequest) => {
    const uid = getRequestContext()?.uid;
    // anonymous callers still get their IP bucket's numbers (login prompt included)
    const clientKey = hashClientKey(req.ip ?? "");
    return deps.quota.summary(uid, clientKey);
  });
}
