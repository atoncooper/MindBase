import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { KgService } from "../../../kg/service.js";
import { KgServiceError } from "../../../kg/service.js";
import { getRequestContext } from "../../../context/request-context.js";

/**
 * KG routes — a contract-mirror of the Python /knowledge/kg/* surface so the
 * frontend kgApi (build/active/status/stats/subgraph) needs zero changes when
 * app-ts enters the gateway. Identity = gateway-injected X-Uid, same as the
 * other app-ts routes.
 */
export function registerKgRoutes(app: FastifyInstance, deps: { kg: KgService }): void {
  const requireUid = (req: FastifyRequest): string | undefined => {
    // uid 在 onRequest 钩子里已按字符串承载（int64 精度安全）
    const uid = getRequestContext()?.uid;
    return typeof uid === "string" ? uid : undefined;
  };

  const respondError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof KgServiceError) {
      return reply.status(err.status).send({ detail: err.message });
    }
    throw err;
  };

  app.post("/knowledge/kg/build", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    const body = (req.body ?? {}) as { folder_ids?: unknown };
    const folderIds = Array.isArray(body.folder_ids)
      ? body.folder_ids.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0)
      : undefined;
    try {
      const { taskId, reused } = await deps.kg.startBuild(uid, folderIds);
      return { task_id: taskId, reused };
    } catch (err) {
      return respondError(reply, err);
    }
  });

  app.get("/knowledge/kg/active", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    const active = await deps.kg.active(uid);
    return { task_id: active?.taskId ?? null };
  });

  app.get("/knowledge/kg/status/:task_id", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    const { task_id } = req.params as { task_id: string };
    const record = await deps.kg.get(task_id, uid);
    if (!record) {
      return reply.status(404).send({ detail: "任务不存在" });
    }
    return {
      task_id: record.taskId,
      status: record.status,
      progress: record.progress,
      current_step: record.currentStep,
      result: record.result ?? null,
      error: record.error ?? null,
    };
  });

  app.get("/knowledge/kg/stats", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    try {
      const stats = await deps.kg.stats();
      return {
        available: stats.available,
        graph: stats.graph,
        entity_vectors: stats.entityVectors,
        pending_pages: stats.pendingPages,
      };
    } catch (err) {
      return respondError(reply, err);
    }
  });

  app.get("/knowledge/kg/subgraph", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    const query = req.query as { center?: string; depth?: string; max_nodes?: string };
    const center = query.center?.trim() || undefined;
    if (center && center.length > 64) {
      return reply.status(400).send({ detail: "center 参数过长" });
    }
    const depth = Math.min(Math.max(Number(query.depth ?? 2) || 2, 1), 3);
    const maxNodes = Math.min(Math.max(Number(query.max_nodes ?? 80) || 80, 5), 200);
    try {
      const sub = await deps.kg.subgraph(center, depth, maxNodes);
      return {
        available: sub.available,
        center: sub.center,
        nodes: sub.nodes,
        edges: sub.edges,
      };
    } catch (err) {
      return respondError(reply, err);
    }
  });
}
