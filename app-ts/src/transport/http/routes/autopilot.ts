import type { FastifyInstance, FastifyReply } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";
import type { ResearchAutopilotSetting } from "../../../repository/research-autopilot.js";
import {
  ResearchAutopilotError,
  type ResearchAutopilotService,
} from "../../../services/research/autopilot.js";
import type { ResearchMetrics } from "../../../services/research/metrics.js";

/** 项目级 Autopilot REST：读取/配置、手动 tick、急停/恢复。 */
export interface AutopilotRouteDeps {
  /** Only the surface the HTTP layer needs (service injected by the composition root). */
  autopilot: Pick<ResearchAutopilotService, "get" | "patch" | "tick">;
  metrics?: ResearchMetrics;
}

export function registerAutopilotRoutes(app: FastifyInstance, deps: AutopilotRouteDeps): void {
  const uidOf = (): string | undefined => {
    const uid = getRequestContext()?.uid;
    return typeof uid === "string" ? uid : undefined;
  };

  const requireUid = (reply: FastifyReply): string | undefined => {
    const uid = uidOf();
    if (uid === undefined) {
      void reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
      return undefined;
    }
    return uid;
  };

  /** ResearchAutopilotError carries its HTTP status (404 missing project / 422 bad body). */
  const run = async <T>(reply: FastifyReply, handler: () => Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await handler();
    } catch (err) {
      if (err instanceof ResearchAutopilotError) {
        return reply.status(err.status).send({ detail: err.message });
      }
      throw err;
    }
  };

  // ---- read / configure ----------------------------------------------------

  app.get("/academic/projects/:projectId/autopilot", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, async () => settingPayload(await deps.autopilot.get(uid, projectId)));
  });

  app.patch("/academic/projects/:projectId/autopilot", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, async () => settingPayload(await deps.autopilot.patch(uid, projectId, req.body ?? {})));
  });

  // ---- deterministic tick --------------------------------------------------

  app.post("/academic/projects/:projectId/autopilot/tick", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    deps.metrics?.inc("autopilot_tick");
    return run(reply, () => deps.autopilot.tick(uid, projectId));
  });

  // ---- emergency stop / resume --------------------------------------------

  app.post("/academic/projects/:projectId/autopilot/stop", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, async () =>
      settingPayload(await deps.autopilot.patch(uid, projectId, { stopped: true })),
    );
  });

  app.post("/academic/projects/:projectId/autopilot/resume", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, async () =>
      settingPayload(await deps.autopilot.patch(uid, projectId, { stopped: false })),
    );
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Explicit projection: camelCase setting fields, no Mongo _id. */
function settingPayload(setting: ResearchAutopilotSetting): Record<string, unknown> {
  return {
    uid: setting.uid,
    projectId: setting.projectId,
    mode: setting.mode,
    maxActionsPerDay: setting.maxActionsPerDay,
    actionsToday: setting.actionsToday,
    day: setting.day,
    ...(setting.stoppedAt !== undefined ? { stoppedAt: setting.stoppedAt } : {}),
    ...(setting.lastTickAt !== undefined ? { lastTickAt: setting.lastTickAt } : {}),
    ...(setting.lastResult !== undefined ? { lastResult: setting.lastResult } : {}),
    updatedAt: setting.updatedAt,
  };
}
