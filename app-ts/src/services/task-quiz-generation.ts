import { z } from "zod";
import { generateObject } from "ai";
import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import { createGatewayModel } from "../llm/provider.js";
import { MemoryTaskQuizDocStore } from "../repository/memory/task-quiz-docs.js";
import { MongoTaskQuizDocStore } from "../repository/mongo/task-quiz-docs.js";
import {
  taskTimeLimitSeconds,
  type TaskQuizDoc,
  type TaskQuizQuestion,
} from "../repository/task-quiz-docs.js";
import { AppQuizClient } from "./app-quiz-client.js";
import { AppTaskClient, bestEffort } from "./app-task-client.js";
import type { PromptRegistry } from "../agent/prompts/loader.js";

const log = createLogger("TASK_QUIZ_GEN");

/**
 * Scheduled-quiz generation flow (the AI side of the app-task executor
 * callback, successor of Python's /internal/quiz/generate-llm):
 *   executor POST (X-Task-Id) → 202 {status: generating|ready}
 *     → background: upsert quiz_task row (app-quiz) → structured LLM
 *     generation (3 retries) → Mongo doc ready → app-quiz mark generated
 *     (awaiting_answer + deadline) → quiz delivery email via app-task →
 *     executor completion report. Every notification/callback is best-effort.
 */

const QuestionSchema = z.object({
  question: z.string().min(1),
  question_type: z.enum(["fill_blank", "choice", "short_answer"]),
  options: z.array(z.string()).nullable(),
  answer: z.string().min(1),
  difficulty: z.enum(["easy", "medium", "hard"]),
  answer_time_limit_seconds: z.number().int().positive(),
});

const QuizSetSchema = z.object({
  questions: z.array(QuestionSchema).min(1).max(5),
});

export interface TaskQuizGenerateInput {
  prompt: string;
  uid: string;
  difficulty: string;
  questionCount: number;
  userEmail: string;
  ccEmails: string[];
  incompleteMessage: string | null;
}

export class TaskQuizGenerationService {
  private readonly docs: MongoTaskQuizDocStore | MemoryTaskQuizDocStore;
  private readonly appQuiz: AppQuizClient;
  private readonly appTask: AppTaskClient;
  private readonly genModel?: ReturnType<typeof createGatewayModel>;
  private readonly prompts: PromptRegistry;

  constructor(deps: {
    docs: MongoTaskQuizDocStore | MemoryTaskQuizDocStore;
    appQuiz: AppQuizClient;
    appTask: AppTaskClient;
    /** injectable for tests; default = gateway model */
    genModel?: ReturnType<typeof createGatewayModel>;
    /** LLM 文案统一走 prompts/（task-quiz），代码不内嵌提示词 */
    prompts: PromptRegistry;
  }) {
    this.docs = deps.docs;
    this.appQuiz = deps.appQuiz;
    this.appTask = deps.appTask;
    this.genModel = deps.genModel;
    this.prompts = deps.prompts;
  }

  /** Executor entry: idempotent status check, then spawn the background pipeline. */
  async startGeneration(
    taskId: string,
    input: TaskQuizGenerateInput,
  ): Promise<{ status: "generating" | "ready"; quiz?: { questions: TaskQuizQuestion[] } }> {
    const existing = await this.docs.get(taskId);
    if (existing?.status === "ready") {
      return { status: "ready", quiz: { questions: existing.questions ?? [] } };
    }
    if (existing?.status === "failed") {
      await this.docs.deleteIfFailed(taskId);
    }
    await this.docs.markGenerating({ task_id: taskId, uid: input.uid });
    void this.runPipeline(taskId, input).catch((err) => {
      log.error(`[GEN] pipeline crashed task=${taskId}: ${err instanceof Error ? err.message : err}`);
    });
    return { status: "generating" };
  }

  /** Poll generation status (app-task's status probe). */
  async getStatus(taskId: string): Promise<Record<string, unknown>> {
    const doc: TaskQuizDoc | undefined = await this.docs.get(taskId);
    if (!doc || doc.status === "generating") {
      return { status: "generating" };
    }
    if (doc.status === "failed") {
      return { status: "failed", error: doc.error || "unknown" };
    }
    return { status: "ready", quiz: { questions: doc.questions ?? [] } };
  }

  private async runPipeline(taskId: string, input: TaskQuizGenerateInput): Promise<void> {
    try {
      // 1. business row (idempotent insert; duplicate task_id is fine)
      await this.appQuiz.createTaskQuizRow(input.uid, {
        task_id: taskId,
        prompt: input.prompt,
        difficulty: input.difficulty || "medium",
        question_count: Math.max(1, Math.min(input.questionCount, 5)),
        user_email: input.userEmail,
        cc_emails: input.ccEmails,
        incomplete_message: input.incompleteMessage,
      });

      // 2. structured generation (retry up to genRetries)
      let questions: TaskQuizQuestion[] | undefined;
      let lastError = "unknown";
      for (let attempt = 1; attempt <= Math.max(1, config.taskQuiz.genRetries); attempt++) {
        try {
          questions = await this.generateQuestions(input);
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          log.warn(`[GEN] attempt ${attempt} failed task=${taskId}: ${lastError}`);
        }
      }
      if (!questions) {
        await this.docs.markFailed(taskId, lastError);
        bestEffort(
          this.appTask.completeTask(taskId, "failed", "", `quiz generation failed: ${lastError}`),
          "TASK_COMPLETE",
        );
        return;
      }

      // 3. persist ready + flip the business row + deliver
      await this.docs.markReady(taskId, questions, input.difficulty);
      const limitSeconds = taskTimeLimitSeconds(questions, input.difficulty);
      bestEffort(this.appQuiz.markTaskQuizGenerated(input.uid, taskId, limitSeconds), "MARK_GENERATED");

      if (input.userEmail) {
        const { subject, html } = buildQuizEmail(input, questions, limitSeconds);
        bestEffort(
          this.appTask.sendEmail({
            to: [input.userEmail],
            cc: input.ccEmails,
            subject,
            html,
            reference_id: taskId,
          }),
          "QUIZ_EMAIL",
        );
      }
      bestEffort(
        this.appTask.completeTask(taskId, "completed", `quiz ready (${questions.length}q)`, ""),
        "TASK_COMPLETE",
      );
      log.info(`[GEN] ready task=${taskId} questions=${questions.length}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.docs.markFailed(taskId, message).catch(() => undefined);
      bestEffort(this.appTask.completeTask(taskId, "failed", "", message), "TASK_COMPLETE");
      log.error(`[GEN] failed task=${taskId}: ${message}`);
    }
  }

  private async generateQuestions(input: TaskQuizGenerateInput): Promise<TaskQuizQuestion[]> {
    const model = this.genModel ?? createGatewayModel("task_quiz_gen", { temperature: 0.7, uid: input.uid });
    const count = Math.max(1, Math.min(input.questionCount, 5));
    const userMessage = `出题方向：${input.prompt}\n难度：${input.difficulty}\n出题数量：${count}`;
    const { object } = await generateObject({
      model,
      schema: QuizSetSchema,
      system: this.prompts.render("task-quiz", {}),
      prompt: userMessage,
    });
    return object.questions.map((q) => ({ ...q })) as TaskQuizQuestion[];
  }
}

/** ≤2 questions inline; >2 questions show only the count (Python parity). */
function buildQuizEmail(
  input: TaskQuizGenerateInput,
  questions: TaskQuizQuestion[],
  limitSeconds: number,
): { subject: string; html: string } {
  const subject = "【MindBase】您的定时出题任务";
  const minutes = Math.round(limitSeconds / 60);
  const head = `<p>您的定时出题任务已生成（${questions.length} 题，限时 ${minutes} 分钟），请登录 MindBase 完成：</p><p><a href="/">前往作答</a></p>`;
  let body = "";
  if (questions.length > 0 && questions.length <= 2) {
    body = questions
      .map((q, i) => {
        const qtext = escapeHtml(q.question);
        const opts = (q.options ?? []).map((o) => `<li style="margin:2px 0;">${escapeHtml(o)}</li>`).join("");
        const list = opts ? `<ul style="margin:0 0 6px 0;padding-left:20px;">${opts}</ul>` : "";
        return `<div style="margin:10px 0;"><p style="margin:0 0 4px 0;"><b>${i + 1}. ${qtext}</b></p>${list}</div>`;
      })
      .join("");
  }
  const tail = input.incompleteMessage
    ? `<p style="color:#666;">提醒语录：${escapeHtml(input.incompleteMessage)}</p>`
    : "";
  return { subject, html: `<!doctype html><html><body>${head}${body}${tail}</body></html>` };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
