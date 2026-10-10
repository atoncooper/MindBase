import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";
import { config } from "../../../config/index.js";
import { createLogger } from "../../../logger.js";
import { AppTaskError } from "../../../services/app-task-client.js";
import { AppAuthError } from "../../../services/app-auth-client.js";
import { AppQuizError } from "../../../services/app-quiz-client.js";
import {
  TaskQuizGenerationService,
  type TaskQuizGenerateInput,
} from "../../../services/task-quiz-generation.js";
import { streamTaskQuizAgent, type TaskQuizFrame } from "../../../services/task-quiz-agent.js";

const log = createLogger("HTTP");

/**
 * Task-quiz routes (successor of the Python task_quiz / internal_quiz
 * routers):
 *  - POST /task-quiz/chat         — agent SSE, simple frame protocol
 *  - POST /task-quiz/register     — user form → app-task /tasks/register
 *  - POST /internal/quiz/generate-llm — app-task executor callback (key-auth)
 *  - GET  /internal/quiz/status/:task_id — app-task status probe
 */

const DIFFICULTIES = new Set(["easy", "medium", "hard"]);

export function registerTaskQuizRoutes(
  app: FastifyInstance,
  deps: {
    generation: TaskQuizGenerationService;
    appTask: import("../../../services/app-task-client.js").AppTaskClient;
    appAuth: import("../../../services/app-auth-client.js").AppAuthClient;
    /** test-only model override for the chat agent */
    agentModel?: Parameters<typeof streamTaskQuizAgent>[2];
  },
): void {
  const requireUid = (req: FastifyRequest): string | undefined => {
    const uid = getRequestContext()?.uid;
    return typeof uid === "string" ? uid : undefined;
  };

  // ---- POST /task-quiz/chat — agent SSE (simple frames) ----
  app.post("/task-quiz/chat", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) {
      return reply.status(401).send({ detail: "unauthorized (X-Uid missing)" });
    }
    const body = (req.body ?? {}) as { message?: string };
    const message = (body.message ?? "").trim();
    if (!message) {
      return reply.status(400).send({ detail: "message 不能为空" });
    }
    let userEmail = "";
    try {
      userEmail = await deps.appAuth.getUserEmail(uid);
    } catch (err) {
      if (err instanceof AppAuthError && err.status === 404) {
        return reply.status(404).send({ detail: "用户不存在" });
      }
      log.warn(`email lookup failed uid=${uid}: ${err instanceof Error ? err.message : err}`);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (frame: TaskQuizFrame) => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
    };
    try {
      for await (const frame of streamTaskQuizAgent(deps, { uid, userEmail, message }, deps.agentModel)) {
        send(frame);
      }
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end();
    }
    return reply;
  });

  // ---- POST /task-quiz/register — user form → app-task ----
  app.post("/task-quiz/register", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) {
      return reply.status(401).send({ detail: "unauthorized (X-Uid missing)" });
    }
    const body = (req.body ?? {}) as {
      prompt?: string;
      difficulty?: string;
      question_count?: number;
      trigger_time?: string;
      cc_emails?: string[];
      incomplete_message?: string | null;
    };
    const prompt = (body.prompt ?? "").trim();
    if (!prompt || prompt.length > 500) {
      return reply.status(400).send({ detail: "prompt 必填且不超过 500 字" });
    }
    const difficulty = body.difficulty || "medium";
    if (!DIFFICULTIES.has(difficulty)) {
      return reply.status(400).send({ detail: "difficulty 必须是 easy/medium/hard" });
    }
    const questionCount = Math.max(1, Math.min(Number(body.question_count ?? 1) || 1, 5));
    let userEmail = "";
    try {
      userEmail = await deps.appAuth.getUserEmail(uid);
    } catch (err) {
      if (err instanceof AppAuthError && err.status === 404) {
        return reply.status(404).send({ detail: "用户不存在" });
      }
      throw err;
    }
    if (!userEmail) {
      return reply.status(400).send({ detail: "user email not found; set email in profile first" });
    }
    // trigger_time must be in the future (tolerate 1min clock skew)
    const trigger = new Date((body.trigger_time ?? "").replace("Z", "+00:00"));
    if (Number.isNaN(trigger.getTime())) {
      return reply.status(400).send({ detail: "invalid trigger_time (expect ISO8601)" });
    }
    if (trigger.getTime() < Date.now() - 60_000) {
      return reply.status(400).send({ detail: "触发时间必须晚于当前时间" });
    }
    try {
      const result = await deps.appTask.registerTask({
        uid,
        task_type: "http",
        // 域标签：调度列表按域过滤（前端 /tasks?domain=task_quiz），
        // 避免其他域（如 app-pay 订单超时委托）的任务串进定时出题页面。
        domain: "task_quiz",
        payload: {
          uid,
          prompt,
          difficulty,
          question_count: questionCount,
          user_email: userEmail,
          cc_emails: body.cc_emails ?? [],
          incomplete_message: body.incomplete_message ?? "",
        },
        executor_url: config.taskQuiz.executorUrl,
        async: true,
        trigger_time: body.trigger_time,
      });
      return result;
    } catch (err) {
      if (err instanceof AppTaskError) {
        return reply.status(502).send({ detail: err.message.slice(0, 200) });
      }
      return reply.status(502).send({ detail: `app-task unreachable: ${err instanceof Error ? err.message : err}` });
    }
  });

  // ---- POST /internal/quiz/generate-llm — app-task executor callback ----
  app.post("/internal/quiz/generate-llm", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as {
      prompt?: string;
      uid?: string;
      difficulty?: string;
      question_count?: number;
      task_id?: string;
      user_email?: string;
      cc_emails?: string[];
      incomplete_message?: string | null;
    };
    const taskId = body.task_id || (req.headers["x-task-id"] as string) || "";
    if (!taskId) {
      return reply.status(400).send({ detail: "X-Task-Id required" });
    }
    const prompt = (body.prompt ?? "").trim();
    if (!prompt) {
      return reply.status(400).send({ detail: "prompt 不能为空" });
    }
    const questionCount = Math.max(1, Math.min(Number(body.question_count ?? 1) || 1, 5));
    const input: TaskQuizGenerateInput = {
      prompt,
      uid: String(body.uid ?? ""),
      difficulty: body.difficulty || "medium",
      questionCount,
      userEmail: body.user_email ?? "",
      ccEmails: Array.isArray(body.cc_emails) ? body.cc_emails : [],
      incompleteMessage: body.incomplete_message ?? null,
    };
    try {
      const result = await deps.generation.startGeneration(taskId, input);
      // 202 accepted → app-task marks the task running
      return reply.status(202).send(result);
    } catch (err) {
      if (err instanceof AppQuizError && err.status === 503) {
        return reply.status(503).send({ detail: err.message });
      }
      if (err instanceof AppQuizError) {
        return reply.status(400).send({ detail: err.message });
      }
      throw err;
    }
  });

  // ---- GET /internal/quiz/status/:task_id — app-task status probe ----
  app.get("/internal/quiz/status/:task_id", async (req: FastifyRequest, reply: FastifyReply) => {
    const { task_id } = req.params as { task_id: string };
    return deps.generation.getStatus(task_id);
  });
}
