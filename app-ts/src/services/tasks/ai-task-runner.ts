import { randomUUID } from "node:crypto";
import type { ChatService } from "../chat.js";
import type { ChatSessionRepository, MessageRepository } from "../../repository/persistence.js";
import {
  nextAiTaskRunAt,
  type AiTask,
  type AiTaskRepository,
  type AiTaskRun,
} from "../../repository/ai-tasks.js";
import { runWithRequestContext } from "../../context/request-context.js";
import { createLogger } from "../../logger.js";
import type { AppTaskClient } from "../../clients/app-task-client.js";
import type { AppUserAuthClient } from "../../clients/app-user-auth-client.js";
import { renderTaskEmail } from "./email-html.js";

const log = createLogger("AI_TASKS");
const MAX_REPORT_CHARS = 200_000;
const DEFAULT_TASK_TIMEOUT_MS = 8 * 60_000;

export class AiTaskRunner {
  constructor(
    private readonly repo: AiTaskRepository,
    private readonly chat: ChatService,
    private readonly messages?: MessageRepository,
    private readonly timeoutMs: number = DEFAULT_TASK_TIMEOUT_MS,
    private readonly notifier?: {
      appTask: Pick<AppTaskClient, "sendEmail">;
      appAuth: Pick<AppUserAuthClient, "getUserEmail">;
    },
    private readonly cleanup?: {
      sessions: Pick<ChatSessionRepository, "delete">;
      messages: Pick<MessageRepository, "deleteBySession">;
    },
  ) {}

  private readonly controllers = new Map<string, AbortController>();

  /** Request cancellation of a queued/running run; returns false if it is not in flight. */
  cancel(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async run(task: AiTask, run: AiTaskRun): Promise<void> {
    const current = await this.repo.getRun(task.uid, run.id);
    if (current?.status === "cancelled") {
      await this.repo.updateTask(task.uid, task.id, { lockedUntil: null });
      return;
    }
    const startedAt = Date.now();
    await this.repo.updateRun(run.id, { status: "running", startedAt, lastHeartbeatAt: startedAt });
    const sessionId = randomUUID();
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    let cancelled = false;
    let timedOut = false;
    controller.signal.addEventListener("abort", () => {
      if (!timedOut) cancelled = true;
    }, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const heartbeat = setInterval(() => {
      const now = Date.now();
      void this.repo.updateRun(run.id, { lastHeartbeatAt: now }).catch(() => undefined);
      void this.repo.updateTask(task.uid, task.id, { lockedUntil: now + this.timeoutMs }).catch(() => undefined);
    }, 30_000);
    let content = "";
    let error: string | undefined;
    try {
      await runWithRequestContext(
        { requestId: randomUUID(), uid: task.uid, startedAt },
        async () => {
          for await (const frame of this.chat.askStream({
            query: buildTaskPrompt(task),
            uid: task.uid,
            sessionId,
            signal: controller.signal,
            ...(task.academicProjectId ? { academicProjectId: task.academicProjectId } : {}),
          })) {
            if (frame.type === "chunk") content += frame.content;
            else if (frame.type === "error") error = frame.message;
          }
        },
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      this.controllers.delete(run.id);
    }

    if (!content && this.messages) {
      try {
        const recent = await this.messages.recentMessages(sessionId, 4);
        const assistant = [...recent].reverse().find((m) => m.role === "assistant" && m.content.trim() !== "");
        if (assistant) content = assistant.content;
      } catch (err) {
        log.warn("[AI_TASKS] report recovery failed session=" + sessionId + ": " + (err instanceof Error ? err.message : err));
      }
    }

    const finishedAt = Date.now();
    const status = cancelled ? "cancelled" : error ? "failed" : "succeeded";
    const report = content.slice(0, MAX_REPORT_CHARS);
    await this.repo.updateRun(run.id, {
      status,
      finishedAt,
      ...(report ? { content: report, summary: summarize(report) } : {}),
      ...(error ? { error } : {}),
    });

    const nextRunAt = task.status === "active" ? nextAiTaskRunAt(task.schedule, finishedAt) : null;
    const completed = task.status === "active" && nextRunAt === null;
    await this.repo.updateTask(task.uid, task.id, {
      lastRunAt: finishedAt,
      lastRunStatus: status,
      lastRunId: run.id,
      runCount: task.runCount + 1,
      lastError: error ? error.slice(0, 500) : null,
      nextRunAt,
      status: completed ? "completed" : task.status,
      lockedUntil: null,
    });
    log.info(
      "[AI_TASKS] run " + run.id + " task=" + task.id + " status=" + status +
        " session=" + sessionId + " chars=" + report.length,
    );
    await this.notifyByEmail(task, run, status, report, error);
    await this.cleanupTaskSession(sessionId);
  }

  /** Drop the ephemeral task session so memory usage does not grow per run. */
  private async cleanupTaskSession(sessionId: string): Promise<void> {
    if (!this.cleanup) return;
    await this.cleanup.messages.deleteBySession(sessionId).catch(() => undefined);
    await this.cleanup.sessions.delete(sessionId).catch(() => undefined);
  }

  /** Best-effort email notification; never changes the run result. */
  private async notifyByEmail(
    task: AiTask,
    run: AiTaskRun,
    status: "succeeded" | "failed" | "cancelled",
    content: string,
    error: string | undefined,
  ): Promise<void> {
    if (task.notifyEmail === false || !this.notifier) return;
    try {
      const email = await this.notifier.appAuth.getUserEmail(task.uid);
      if (!email) return;
      await this.notifier.appTask.sendEmail({
        to: [email],
        cc: [],
        subject: "[MindBase] 定时任务「" + task.title + "」" + (status === "succeeded" ? "已完成" : status === "cancelled" ? "已取消" : "执行失败"),
        html: renderTaskEmail({
          title: task.title,
          status,
          when: new Date(run.startedAt ?? run.createdAt).toLocaleString("zh-CN", {
            timeZone: task.schedule.timezone,
          }),
          content,
          ...(error ? { error } : {}),
        }),
        reference_id: "ai-task-" + run.id,
      });
      log.info("[AI_TASKS] email sent task=" + task.id + " run=" + run.id);
    } catch (err) {
      log.warn("[AI_TASKS] email notification failed task=" + task.id + ": " + (err instanceof Error ? err.message : err));
    }
  }
}

function buildTaskPrompt(task: AiTask): string {
  const kindGuidance =
    task.kind === "news"
      ? [
          "这是一次新闻摘要任务。请使用 web_search 检索最近 24-72 小时的相关新闻。",
          "优先选择有明确来源链接的条目；不要编造标题、日期或链接。",
          "输出 5-8 条最重要信息，每条附来源链接。",
        ]
      : task.kind === "literature"
        ? [
            "这是一次文献收集任务。请使用 academic_literature 在指定科研项目中检索。",
            "只使用工具返回的真实文献，不得编造 DOI、作者、期刊或年份。",
            "按相关性排序，输出 5-10 篇，附 DOI/链接与一句话摘要。",
          ]
        : task.kind === "report"
          ? [
              "这是一次汇报任务。请综合可用的项目、知识库或云盘上下文，形成结构化汇报。",
              "明确区分事实、推断和建议；没有依据的内容不要写成确定事实。",
            ]
          : ["请围绕任务目标收集信息、核对来源，并直接给出可阅读的汇报。"];

  return [
    "【定时任务】" + task.title,
    "任务类型：" + task.kind,
    task.academicProjectId ? "科研项目 ID：" + task.academicProjectId : "",
    "",
    "任务指令：",
    task.prompt,
    "",
    "执行要求：",
    ...kindGuidance.map((line) => "- " + line),
    "- 仅在必要时调用工具；工具失败时如实说明，不要伪造数据。",
    "- 最终回答必须是一份完整的中文 Markdown 汇报，而不是一句确认。",
    "",
    "汇报结构：",
    "# " + task.title,
    "## 摘要",
    "## 关键信息",
    "## 来源",
    "## 建议 / 下一步",
    "",
    "如果本次没有发现值得汇报的新内容，也要明确说明“本次无新增”，不要空泛填充。",
  ]
    .filter(Boolean)
    .join("\n");
}

function summarize(content: string): string {
  const plain = content
    .replace(/[#>*_\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.slice(0, 500);
}
