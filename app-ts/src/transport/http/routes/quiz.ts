import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";
import { AppQuizError } from "../../../services/app-quiz-client.js";
import { QuizGenerationError, type QuizGenerationService } from "../../../services/quiz-generation.js";
import type { QuizGradingService } from "../../../services/quiz-grading.js";
import { SessionSummaryError } from "../../../services/session-summary.js";

const FOLDER_IDS_PATTERN = /^\d+(,\d+)*$/;

function parseFolderIds(raw: string | undefined): number[] {
  const value = (raw ?? "").trim();
  if (!value) return [];
  if (!FOLDER_IDS_PATTERN.test(value)) {
    throw new QuizGenerationError("folder_ids 格式非法", 400);
  }
  return value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n));
}

/**
 * Quiz AI routes — POST /quiz/generate-from-summary (port of the Python
 * endpoint; app-ts owns the AI orchestration, app-quiz owns the storage).
 * Returns immediately with a generating quiz_uuid; the frontend polls
 * GET /quiz/{uuid} on app-quiz until the status is terminal.
 */
export function registerQuizRoutes(
  app: FastifyInstance,
  deps: { quizGen: QuizGenerationService; quizGrade: QuizGradingService },
): void {
  app.post("/quiz/generate", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = getRequestContext()?.uid;
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    const query = req.query as {
      folder_ids?: string;
      question_count?: string;
      difficulty?: string;
      title?: string;
    };
    const pages = Array.isArray(req.body)
      ? (req.body as Array<{ bvid: string; cid?: number; page_index?: number; page_title?: string }>)
      : undefined;
    try {
      return await deps.quizGen.startFromSource(uid, {
        folderIds: parseFolderIds(query.folder_ids),
        pages,
        questionCount: Number(query.question_count ?? 10),
        difficulty: query.difficulty ?? "medium",
        title: query.title,
      });
    } catch (err) {
      if (err instanceof QuizGenerationError) {
        return reply.status(err.status).send({ detail: err.message });
      }
      if (err instanceof AppQuizError) {
        return reply.status(err.status ?? 502).send({ detail: err.message });
      }
      throw err;
    }
  });

  // AI 出题（不依赖知识库）：free = 围绕主题自由出题；wrong_answers = 读取错题
  // 本构建错误画像，针对薄弱点出由易到难的变式新题。
  app.post("/quiz/generate-ai", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = getRequestContext()?.uid;
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    const body = (req.body ?? {}) as {
      mode?: string;
      topic?: string;
      question_count?: number;
      difficulty?: string;
      title?: string;
    };
    const mode = body.mode === "wrong_answers" ? "wrong_answers" : "free";
    const count = Number(body.question_count ?? 10);
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      return reply.status(400).send({ detail: "question_count 须在 1-20 之间" });
    }
    try {
      return await deps.quizGen.startAIGenerated(uid, {
        mode,
        topic: typeof body.topic === "string" ? body.topic : undefined,
        questionCount: count,
        difficulty: body.difficulty ?? "medium",
        title: body.title,
      });
    } catch (err) {
      if (err instanceof QuizGenerationError) {
        return reply.status(err.status).send({ detail: err.message });
      }
      if (err instanceof AppQuizError) {
        return reply.status(err.status ?? 502).send({ detail: err.message });
      }
      throw err;
    }
  });

  app.post("/quiz/submit", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = getRequestContext()?.uid;
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    const body = (req.body ?? {}) as {
      quiz_uuid?: string;
      answers?: Array<{ question_uuid?: string; answer?: unknown }>;
      time_spent_seconds?: number;
    };
    const quizUuid = typeof body.quiz_uuid === "string" ? body.quiz_uuid.trim() : "";
    if (!quizUuid) {
      return reply.status(400).send({ detail: "quiz_uuid 不能为空" });
    }
    const answers = (Array.isArray(body.answers) ? body.answers : [])
      .filter((a): a is { question_uuid: string; answer?: unknown } => typeof a?.question_uuid === "string")
      .map((a) => ({ question_uuid: a.question_uuid, answer: a.answer }));
    try {
      return await deps.quizGrade.submitAndGrade(uid, quizUuid, answers, body.time_spent_seconds);
    } catch (err) {
      if (err instanceof QuizGenerationError) {
        return reply.status(err.status).send({ detail: err.message });
      }
      if (err instanceof AppQuizError) {
        return reply.status(err.status ?? 502).send({ detail: err.message });
      }
      throw err;
    }
  });

  app.post("/quiz/generate-from-summary", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = getRequestContext()?.uid;
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    const body = (req.body ?? {}) as {
      chat_session_id?: string;
      question_count?: number;
      difficulty?: string;
    };
    const chatSessionId = typeof body.chat_session_id === "string" ? body.chat_session_id.trim() : "";
    if (!chatSessionId) {
      return reply.status(400).send({ detail: "chat_session_id 不能为空" });
    }
    const count = Number(body.question_count ?? 5);
    if (!Number.isInteger(count) || count < 1 || count > 5) {
      return reply.status(400).send({ detail: "question_count 须在 1-5 之间" });
    }
    const difficulty = typeof body.difficulty === "string" && body.difficulty ? body.difficulty : "medium";
    try {
      return await deps.quizGen.startFromSummary(uid, chatSessionId, count, difficulty);
    } catch (err) {
      if (err instanceof SessionSummaryError) {
        return reply.status(err.status).send({ detail: err.message });
      }
      if (err instanceof AppQuizError) {
        return reply.status(502).send({ detail: err.message });
      }
      throw err;
    }
  });
}
