import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { VecError, type VideoVectorizerService } from "../../../services/video-vectorizer.js";
import { getRequestContext } from "../../../context/request-context.js";

/**
 * /vec/page/* — per-page vectorization status/trigger, contract-mirror of the
 * Python router the frontend vecPageApi consumes (snake_case wire). Identity =
 * gateway-injected X-Uid. The task_id poll endpoint is also what the
 * bili:page_ready pipeline's callers use to watch progress.
 */
export function registerVectorPageRoutes(app: FastifyInstance, deps: { vectorizer: VideoVectorizerService }): void {
  const requireUid = (req: FastifyRequest): string | undefined => {
    // uid 在 onRequest 钩子里已按字符串承载（int64 精度安全）
    const uid = getRequestContext()?.uid;
    return typeof uid === "string" ? uid : undefined;
  };

  const respondError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof VecError) {
      return reply.status(err.status).send({ detail: err.message });
    }
    throw err;
  };

  app.get("/vec/page/status", async (req: FastifyRequest, reply: FastifyReply) => {
    if (requireUid(req) === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    const query = req.query as { bvid?: string; cid?: string };
    if (!query.bvid || !query.cid) {
      return reply.status(400).send({ detail: "bvid 与 cid 必填" });
    }
    try {
      return await deps.vectorizer.pageStatus(query.bvid, Number(query.cid));
    } catch (err) {
      return respondError(reply, err);
    }
  });

  app.post("/vec/page/create", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    const body = (req.body ?? {}) as { bvid?: string; cid?: number; page_index?: number; page_title?: string };
    if (!body.bvid || !body.cid) {
      return reply.status(400).send({ detail: "bvid 与 cid 必填" });
    }
    try {
      return await deps.vectorizer.createTask({
        uid,
        bvid: body.bvid,
        cid: Number(body.cid),
        pageIndex: body.page_index !== undefined ? Number(body.page_index) : undefined,
        pageTitle: body.page_title || undefined,
      });
    } catch (err) {
      return respondError(reply, err);
    }
  });

  app.post("/vec/page/revector", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    const body = (req.body ?? {}) as { bvid?: string; cid?: number };
    if (!body.bvid || !body.cid) {
      return reply.status(400).send({ detail: "bvid 与 cid 必填" });
    }
    try {
      return await deps.vectorizer.revector({ uid, bvid: body.bvid, cid: Number(body.cid) });
    } catch (err) {
      return respondError(reply, err);
    }
  });

  app.get("/vec/page/status/:task_id", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    const { task_id } = req.params as { task_id: string };
    try {
      return await deps.vectorizer.taskStatus(task_id, uid);
    } catch (err) {
      return respondError(reply, err);
    }
  });
}
