import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PlanRunner } from "../../../agent/dag/runner.js";
import type { PlanRunEngine } from "../../../agent/dag/state.js";
import type { PlanRunNode } from "../../../repository/plan-runs.js";
import { getRequestContext } from "../../../context/request-context.js";

export interface PlanRouteDeps {
  engine: PlanRunEngine;
  runner: PlanRunner;
}

/**
 * Durable plan endpoints: a refreshed browser can rehydrate the DAG panel from
 * runId instead of losing the turn-local SSE snapshot. Resume is exposed for
 * callers that want to continue a crashed/incomplete run explicitly.
 *
 * GET /chat/plans lists the caller's recent runs (docs/research-ui-api.md §6):
 * uid is mandatory (gateway X-Uid) and nodeCounts is derived from nodes[].status.
 */
export function registerPlanRoutes(app: FastifyInstance, deps: PlanRouteDeps): void {
  // History MUST be declared before /chat/plans/:runId so the literal path is
  // matched first (Fastify keeps static and param routes apart, but the
  // ordering documents the intent and matches the route table).
  app.get("/chat/plans", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requestUID(req);
    if (!uid) return reply.code(401).send({ detail: "缺少用户身份（X-Uid）" });
    const query = req.query as { limit?: unknown; chat_session_id?: unknown; project_id?: unknown };
    const chatSessionId =
      typeof query.chat_session_id === "string" && query.chat_session_id.trim() !== ""
        ? query.chat_session_id.trim()
        : undefined;
    // Research workbench scoping: /chat/plans?project_id=<academic project>.
    // Only ids matching the backend's own academic-project charset are accepted.
    const projectId =
      typeof query.project_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(query.project_id.trim())
        ? query.project_id.trim()
        : undefined;
    const limit = typeof query.limit === "string" && query.limit.trim() !== "" ? Number(query.limit) : undefined;
    const runs = await deps.engine.list(uid, limit, chatSessionId, projectId);
    return {
      runs: runs.map((run) => ({
        runId: run.runId,
        goal: run.goal,
        status: run.status,
        chatSessionId: run.chatSessionId,
        ...(run.projectId ? { projectId: run.projectId } : {}),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
        nodeCounts: nodeCounts(run.nodes),
      })),
    };
  });

  app.get("/chat/plans/:runId", async (req: FastifyRequest, reply: FastifyReply) => {
    const { runId } = req.params as { runId: string };
    const run = await deps.engine.get(runId);
    if (!run) return reply.code(404).send({ detail: "plan run not found" });
    const uid = headerUID(req);
    if (run.uid && uid && run.uid !== uid) return reply.code(403).send({ detail: "plan run belongs to another user" });
    const snapshot = deps.engine.snapshot(run);
    return {
      runId: run.runId,
      status: run.status,
      chat_session_id: run.chatSessionId,
      updated_at: run.updatedAt,
      plan: snapshot,
    };
  });

  app.post("/chat/plans/:runId/resume", async (req: FastifyRequest, reply: FastifyReply) => {
    const { runId } = req.params as { runId: string };
    const run = await deps.engine.get(runId);
    if (!run) return reply.code(404).send({ detail: "plan run not found" });
    const uid = headerUID(req);
    if (run.uid && uid && run.uid !== uid) return reply.code(403).send({ detail: "plan run belongs to another user" });
    // Resume runs the remaining nodes and returns the final projection. A
    // streaming variant can be added once the frontend needs live replay.
    const result = await deps.runner.resume(runId, {});
    return {
      runId,
      ok: result.ok,
      failed: result.failed,
      skipped: result.skipped,
      outputs: result.outputs,
    };
  });
}

/** Node status bucket counts for the plan-history list (contract §6). */
function nodeCounts(nodes: PlanRunNode[]): {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  running: number;
  pending: number;
} {
  let done = 0;
  let failed = 0;
  let skipped = 0;
  let running = 0;
  let pending = 0;
  for (const node of nodes) {
    switch (node.status) {
      case "done":
        done += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
      case "in_progress":
        running += 1;
        break;
      default:
        pending += 1;
    }
  }
  return { total: nodes.length, done, failed, skipped, running, pending };
}

/** uid from the request context (server middleware) with the gateway header as fallback. */
function requestUID(req: FastifyRequest): string | undefined {
  const fromContext = getRequestContext()?.uid;
  if (typeof fromContext === "string" && /^\d+$/.test(fromContext)) return fromContext;
  return headerUID(req);
}

function headerUID(req: FastifyRequest): string | undefined {
  const raw = req.headers["x-uid"];
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return undefined;
  return raw;
}
