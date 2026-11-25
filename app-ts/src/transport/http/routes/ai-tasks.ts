import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";
import { AiTaskError, AiTaskService } from "../../../services/tasks/ai-tasks.js";
import type { AiTaskRunner } from "../../../services/tasks/ai-task-runner.js";

export interface AiTaskRouteDeps {
  tasks: Pick<AiTaskService, "list" | "get" | "create" | "update" | "pause" | "resume" | "delete" | "prepareRunNow" | "listRuns" | "getRun" | "cancelRun">;
  runner: Pick<AiTaskRunner, "run" | "cancel">;
}

/** /ai-tasks — user-scoped scheduled AI tasks (P0-P2 surface). */
export function registerAiTaskRoutes(app: FastifyInstance, deps: AiTaskRouteDeps): void {
  const uidOf = (): string | undefined => {
    const uid = getRequestContext()?.uid;
    return typeof uid === "string" && uid !== "" ? uid : undefined;
  };
  const requireUid = (reply: FastifyReply): string | undefined => {
    const uid = uidOf();
    if (!uid) {
      void reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
      return undefined;
    }
    return uid;
  };
  const respond = (reply: FastifyReply, err: unknown) => {
    if (err instanceof AiTaskError) return reply.status(err.status).send({ detail: err.message });
    throw err;
  };

  app.get("/ai-tasks", async (_req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    try {
      return { tasks: await deps.tasks.list(uid) };
    } catch (err) {
      return respond(reply, err);
    }
  });

  app.post("/ai-tasks", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    try {
      return await deps.tasks.create(uid, req.body);
    } catch (err) {
      return respond(reply, err);
    }
  });

  // Static run route must be declared before /:id.
  app.get("/ai-tasks/runs/:run_id", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { run_id } = req.params as { run_id: string };
    try {
      return await deps.tasks.getRun(uid, run_id);
    } catch (err) {
      return respond(reply, err);
    }
  });

  app.post("/ai-tasks/runs/:run_id/cancel", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { run_id } = req.params as { run_id: string };
    try {
      deps.runner.cancel(run_id);
      return await deps.tasks.cancelRun(uid, run_id);
    } catch (err) {
      return respond(reply, err);
    }
  });

  app.get("/ai-tasks/:id", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { id } = req.params as { id: string };
    try {
      return await deps.tasks.get(uid, id);
    } catch (err) {
      return respond(reply, err);
    }
  });

  app.patch("/ai-tasks/:id", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { id } = req.params as { id: string };
    try {
      return await deps.tasks.update(uid, id, req.body);
    } catch (err) {
      return respond(reply, err);
    }
  });

  app.delete("/ai-tasks/:id", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { id } = req.params as { id: string };
    try {
      await deps.tasks.delete(uid, id);
      return { deleted: true };
    } catch (err) {
      return respond(reply, err);
    }
  });

  app.post("/ai-tasks/:id/pause", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { id } = req.params as { id: string };
    try {
      return await deps.tasks.pause(uid, id);
    } catch (err) {
      return respond(reply, err);
    }
  });

  app.post("/ai-tasks/:id/resume", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { id } = req.params as { id: string };
    try {
      return await deps.tasks.resume(uid, id);
    } catch (err) {
      return respond(reply, err);
    }
  });

  app.post("/ai-tasks/:id/run", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { id } = req.params as { id: string };
    try {
      const { task, run } = await deps.tasks.prepareRunNow(uid, id);
      void deps.runner.run(task, run).catch(() => undefined);
      return reply.status(202).send({ runId: run.id, status: "queued" });
    } catch (err) {
      return respond(reply, err);
    }
  });

  app.get("/ai-tasks/:id/runs", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { id } = req.params as { id: string };
    const limit = limitOf((req.query as { limit?: unknown }).limit);
    try {
      return { runs: await deps.tasks.listRuns(uid, id, limit) };
    } catch (err) {
      return respond(reply, err);
    }
  });
}

function limitOf(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim() === "") return 20;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 20;
  return Math.min(Math.max(Math.trunc(n), 1), 100);
}
