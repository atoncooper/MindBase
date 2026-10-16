import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";
import { AppQuizError } from "../../../services/app-quiz-client.js";
import {
  QuizGenerationError,
  QUIZ_STYLES,
  expandBlueprintPlan,
  blueprintDistribution,
  MAX_QUIZ_FILES,
  MAX_QUIZ_FILE_BYTES,
  type QuizGenerationService,
  type GenerationPersonalization,
  type QuizStyle,
  type QuizFileInput,
} from "../../../services/quiz-generation.js";
import type { QuizGradingService } from "../../../services/quiz-grading.js";
import { SessionSummaryError } from "../../../services/session-summary.js";
import { EXAM_BLUEPRINTS, blueprintTotal, blueprintExamTotal, getBlueprint, type ExamBlueprint } from "../../../services/quiz-exam-blueprints.js";

const FOLDER_IDS_PATTERN = /^\d+(,\d+)*$/;

/** Parse the personalization triple (style / skill_ids / instructions) shared by all generate endpoints. */
function parsePersonalization(raw: { style?: unknown; skill_ids?: unknown; instructions?: unknown }): GenerationPersonalization | undefined {
  const style = typeof raw.style === "string" && (QUIZ_STYLES as string[]).includes(raw.style) ? (raw.style as QuizStyle) : undefined;
  const skillIds = Array.isArray(raw.skill_ids)
    ? raw.skill_ids.map((s) => String(s).trim()).filter(Boolean).slice(0, 5)
    : typeof raw.skill_ids === "string" && raw.skill_ids.trim()
      ? raw.skill_ids.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 5)
      : undefined;
  const instructions = typeof raw.instructions === "string" && raw.instructions.trim() ? raw.instructions : undefined;
  if (!style && !skillIds?.length && !instructions) return undefined;
  return { style, skillIds, instructions };
}

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
/** 蓝本 → 题型均分（展开全蓝本逐题计划后按题型平均；含未标注项的均摊分值）。 */
function typeScoresOf(b: ExamBlueprint): Record<string, number> {
  const plan = expandBlueprintPlan(b, blueprintTotal(b), "medium");
  const sum: Record<string, number> = {};
  const cnt: Record<string, number> = {};
  for (const p of plan) {
    sum[p.type] = (sum[p.type] ?? 0) + p.score;
    cnt[p.type] = (cnt[p.type] ?? 0) + 1;
  }
  const out: Record<string, number> = {};
  for (const t of Object.keys(sum)) out[t] = Math.round((sum[t] / cnt[t]) * 100) / 100;
  return out;
}

export function registerQuizRoutes(
  app: FastifyInstance,
  deps: { quizGen: QuizGenerationService; quizGrade: QuizGradingService },
): void {
  // 考试蓝本目录（前端选择器数据源）：66 种考试的题型分布结构
  app.get("/quiz/styles", async () => {
    return EXAM_BLUEPRINTS.map((b) => ({
      id: b.id,
      category: b.category,
      name: b.name,
      description: b.description,
      duration_minutes: b.durationMinutes,
      total: blueprintTotal(b),
      // 断点续跑/存量卷分值推断：题型分布 + 每题型均分（蓝本固有分值）
      distribution: blueprintDistribution(b),
      type_scores: typeScoresOf(b),
    }));
  });

  // 断点续跑：partial 卷从 checkpoint 断点补齐剩余题目（app-quiz reopen
  // partial→generating + 内容记忆从落库题目重建 + 蓝图剩余槽位续写）。
  app.post("/quiz/resume", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = getRequestContext()?.uid;
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    const body = (req.body ?? {}) as { quiz_uuid?: unknown };
    const quizUuid = String(body.quiz_uuid ?? "").trim();
    if (!quizUuid) {
      return reply.status(400).send({ detail: "quiz_uuid 必填" });
    }
    try {
      return await deps.quizGen.resumeAIGeneration(uid, quizUuid);
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
      style?: string;
      skill_ids?: string;
      instructions?: string;
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
        personalization: parsePersonalization(query),
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
      style?: string;
      skill_ids?: unknown;
      instructions?: string;
    };
    const mode = body.mode === "wrong_answers" ? "wrong_answers" : "free";
    // question_count 缺省 = auto：语义配卷（后端由主题推断 PaperSpec，题量/结构由 AI 决定）
    const rawCount = body.question_count;
    const hasCount = rawCount !== undefined && rawCount !== null;
    const count = hasCount ? Number(rawCount) : undefined;
    if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 50)) {
      return reply.status(400).send({ detail: "question_count 须在 1-50 之间" });
    }
    try {
      return await deps.quizGen.startAIGenerated(uid, {
        mode,
        topic: typeof body.topic === "string" ? body.topic : undefined,
        questionCount: count,
        difficulty: body.difficulty ?? "medium",
        title: body.title,
        personalization: parsePersonalization(body),
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
      style?: string;
      skill_ids?: unknown;
      instructions?: string;
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
      return await deps.quizGen.startFromSummary(uid, chatSessionId, count, difficulty, parsePersonalization(body));
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

  // 上传出题（multipart）：错题图片强化（wrong_images）/ 文件模仿出题（mimic）。
  // 图片走 OCR 视觉转写、文本类文档走 parseDocument → LLM 结构化提取 → 变式出题。
  // 返回 generating quiz_uuid，前端轮询 GET /quiz/{uuid}（app-quiz）。
  app.post("/quiz/generate-from-images", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = getRequestContext()?.uid;
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    const files: QuizFileInput[] = [];
    const fields: Record<string, string> = {};
    try {
      for await (const part of req.parts({
        limits: { fileSize: MAX_QUIZ_FILE_BYTES, files: MAX_QUIZ_FILES + 1 },
      })) {
        if (part.type === "file") {
          if (files.length >= MAX_QUIZ_FILES) {
            return reply.status(400).send({ detail: "最多上传 " + MAX_QUIZ_FILES + " 个文件" });
          }
          const buffer = await part.toBuffer();
          files.push({ filename: part.filename || "unnamed", buffer, mime: part.mimetype || "application/octet-stream" });
        } else if (part.fieldname) {
          fields[part.fieldname] = String(part.value ?? "");
        }
      }
    } catch {
      return reply.status(413).send({
        detail: "文件读取失败（单个文件上限 " + Math.floor(MAX_QUIZ_FILE_BYTES / 1024 / 1024) + "MB）",
      });
    }
    const mode = fields.mode === "mimic" ? "mimic" : fields.mode === "standard" ? "standard" : "wrong_images";
    const count = Number(fields.question_count ?? 10);
    if (!Number.isInteger(count) || count < 1 || count > (mode === "standard" ? 50 : 20)) {
      return reply.status(400).send({ detail: "question_count 须在 1-" + (mode === "standard" ? 50 : 20) + " 之间" });
    }
    try {
      // 大纲/规范出题：上传大纲文档 → 语义配卷蓝图 → 按标准生成；可选 folder_ids 接地
      if (mode === "standard") {
        return await deps.quizGen.startFromStandard(uid, {
          files,
          folderIds: parseFolderIds(fields.folder_ids),
          questionCount: count,
          difficulty: fields.difficulty || "medium",
          title: fields.title || undefined,
          personalization: parsePersonalization(fields),
        });
      }
      return await deps.quizGen.startFromFiles(uid, {
        mode,
        files,
        topic: fields.topic || undefined,
        questionCount: count,
        difficulty: fields.difficulty || "medium",
        title: fields.title || undefined,
        personalization: parsePersonalization(fields),
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
}
