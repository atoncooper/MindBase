import type { FastifyInstance, FastifyRequest } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";
import { hashClientKey, type QuotaService } from "../../../services/quota.js";

/**
 * GET /quota/summary — the signed-in user's (or the IP bucket's) daily usage:
 * every configured kind + the cost block. Consumed by the chat page badge and
 * the membership center usage section.
 */
export function registerQuotaRoutes(app: FastifyInstance, deps: { quota: QuotaService }): void {
  app.get("/quota/summary", async (req: FastifyRequest) => {
    const uid = getRequestContext()?.uid;
    // anonymous callers still get their IP bucket's numbers (login prompt included)
    const clientKey = hashClientKey(req.ip ?? "");
    return deps.quota.summary(uid, clientKey);
  });
}
