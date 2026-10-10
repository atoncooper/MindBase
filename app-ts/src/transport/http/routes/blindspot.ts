import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";
import { BlindspotError, type BlindspotService } from "../../../services/blindspot.js";
import { QuizGenerationError } from "../../../services/quiz-generation.js";
import { AppQuizError } from "../../../services/app-quiz-client.js";

/**
 * /blindspot/* — knowledge blind-spot map (contract mirror of the Python
 * router): five-quadrant map, entity detail, one-click weak-entity quiz.
 */
export function registerBlindspotRoutes(app: FastifyInstance, deps: { blindspot: BlindspotService }): void {
  const requireUid = (req: FastifyRequest): string | undefined => {
    // uid 在 onRequest 钩子里已按字符串承载（int64 精度安全）
    const uid = getRequestContext()?.uid;
    return typeof uid === "string" ? uid : undefined;
  };

  const parseFolderIds = (raw: string | undefined): number[] => {
    if (!raw) return [];
    const out: number[] = [];
    for (const part of raw.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n <= 0) {
        throw new BlindspotError(400, `非法的 folder_id: ${trimmed}`);
      }
      out.push(n);
    }
    return out;
  };

  app.get("/blindspot/map", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    try {
      const query = req.query as { folder_ids?: string };
      return await deps.blindspot.map(uid, parseFolderIds(query.folder_ids));
    } catch (err) {
      if (err instanceof BlindspotError) {
        return reply.status(err.status).send({ detail: err.message });
      }
      return reply.status(500).send({ detail: "盲区地图加载失败，请稍后重试" });
    }
  });

  app.get("/blindspot/entity/:eid", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    const { eid } = req.params as { eid: string };
    if (!eid || eid.length > 128) {
      return reply.status(400).send({ detail: "非法实体 ID" });
    }
    try {
      const detail = await deps.blindspot.entityDetail(uid, eid);
      if (detail === null) {
        return reply.status(404).send({ detail: "实体不存在或图谱不可用" });
      }
      return detail;
    } catch (err) {
      if (err instanceof BlindspotError) {
        return reply.status(err.status).send({ detail: err.message });
      }
      return reply.status(500).send({ detail: "实体详情加载失败，请稍后重试" });
    }
  });

  app.post("/blindspot/:eid/quiz", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    const { eid } = req.params as { eid: string };
    if (!eid || eid.length > 128) {
      return reply.status(400).send({ detail: "非法实体 ID" });
    }
    const body = (req.body ?? {}) as { question_count?: number; difficulty?: string };
    const questionCount = Math.max(1, Math.min(Number(body.question_count ?? 5) || 5, 20));
    const difficulty = ["easy", "medium", "hard"].includes(body.difficulty ?? "") ? (body.difficulty as string) : "medium";
    try {
      return await deps.blindspot.startEntityQuiz(uid, eid, { questionCount, difficulty });
    } catch (err) {
      if (err instanceof BlindspotError) {
        return reply.status(err.status).send({ detail: err.message });
      }
      if (err instanceof QuizGenerationError) {
        return reply.status(err.status).send({ detail: err.message });
      }
      if (err instanceof AppQuizError) {
        return reply.status(err.status ?? 502).send({ detail: err.message });
      }
      return reply.status(500).send({ detail: "出题失败，请稍后重试" });
    }
  });
}
