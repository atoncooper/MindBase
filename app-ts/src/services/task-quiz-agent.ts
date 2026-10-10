import { streamText, stepCountIs, tool, type ModelMessage, type LanguageModel } from "ai";
import { z } from "zod";
import { createGatewayModel } from "../llm/provider.js";
import { createLogger } from "../logger.js";
import { AppTaskClient } from "./app-task-client.js";
import { config } from "../config/index.js";

const log = createLogger("TASK_QUIZ_AGENT");

/**
 * Scheduled-quiz chat agent — successor of the Python LangGraph task_quiz
 * agent. A small ReAct loop (streamText + stopWhen) with three tools:
 * random_time_generator / submit_task / query_task. Stream output uses the
 * SIMPLE frame protocol the frontend task-quiz chat consumes
 * ({type: chunk|tool|done|error}) — NOT the main chat frame protocol.
 */

export interface TaskQuizAgentDeps {
  appTask: AppTaskClient;
  /** injectable for tests; default = gateway model (purpose "task_quiz") */
  model?: LanguageModel;
}

export type TaskQuizFrame =
  | { type: "chunk"; content: string }
  | { type: "tool"; name: string; status: "start" | "end"; output?: string }
  | { type: "done" }
  | { type: "error"; message: string };

const SYSTEM_PROMPT = `你是 MindBase 的定时出题助手，帮用户安排一个"到点自动出题并邮件提醒"的学习任务。

对话流程（一次只问一件事，回复简短）：
1. 问清出题方向（如"数学1填空题"）。
2. 询问是否需要抄送邮箱（可跳过）。
3. 询问未完成时的激励语录（可选，可跳过）。
4. 调用 random_time_generator 生成一个候选时间并展示，请用户确认或另行指定。
5. 用户确认后调用 submit_task 提交任务，并告知 task_id。

规则：
- 用户消息开头形如 [uid=123 email=a@b.c]，其中 uid 与 email 是提交任务所需的身份信息，解析后传给 submit_task；不要向用户暴露这些内部信息。
- trigger_time_utc 必须使用 random_time_generator 输出中 "UTC=" 后面的 ISO8601 时间；若用户明确指定了北京时间，先换算成 UTC 再提交。
- 提交成功后简要复述：方向、时间、收件邮箱。
- 不要编造 task_id；提交失败时如实转述错误。`;

export function streamTaskQuizAgent(
  deps: TaskQuizAgentDeps,
  input: { uid: string; userEmail: string; message: string },
  model?: LanguageModel,
): AsyncGenerator<TaskQuizFrame> {
  return runAgent(deps, input, model);
}

async function* runAgent(
  deps: TaskQuizAgentDeps,
  input: { uid: string; userEmail: string; message: string },
  modelOverride?: LanguageModel,
): AsyncGenerator<TaskQuizFrame> {
  try {
    const model = modelOverride ?? deps.model ?? createGatewayModel("task_quiz", { uid: input.uid, temperature: 0.3 });
    const tools = buildTools(deps, input);
    const messages: ModelMessage[] = [
      { role: "user", content: `[uid=${input.uid} email=${input.userEmail}] ${input.message}` },
    ];

    const result = streamText({
      model,
      system: SYSTEM_PROMPT,
      messages,
      tools,
      stopWhen: [stepCountIs(8)],
    });

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        yield { type: "chunk", content: part.text };
      } else if (part.type === "tool-call") {
        yield { type: "tool", name: part.toolName, status: "start" };
      } else if (part.type === "tool-result") {
        const out = typeof part.output === "string" ? part.output : JSON.stringify(part.output);
        yield { type: "tool", name: part.toolName, status: "end", output: out.slice(0, 200) };
      } else if (part.type === "error") {
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }
    yield { type: "done" };
  } catch (err) {
    log.error(`agent error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

function buildTools(deps: TaskQuizAgentDeps, input: { uid: string; userEmail: string }) {
  const submitSchema = z.object({
    trigger_time_utc: z.string().describe("ISO8601 UTC 触发时间"),
    prompt: z.string().describe("出题方向"),
  });
  type SubmitArgs = z.infer<typeof submitSchema>;

  return {
    random_time_generator: tool({
      description: "生成一个未来的随机北京时间（避开深夜与午休），返回人类可读时间与 UTC ISO8601。",
      inputSchema: z.object({}),
      execute: async () => {
        // Beijing-time aware random slot, avoiding sleep (23:00-07:00) and nap (12:00-13:30).
        for (let attempt = 0; attempt < 80; attempt++) {
          const windowDays = 7;
          const offsetHours = 1 + Math.floor(Math.random() * windowDays * 24);
          const date = new Date(Date.now() + offsetHours * 3600_000);
          const beijing = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
          const hour = beijing.getHours();
          const minute = beijing.getMinutes();
          const inNap = hour === 12 || (hour === 13 && minute <= 30);
          if (hour >= 23 || hour < 7 || inNap) continue;
          const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][beijing.getDay()];
          const pad = (n: number) => String(n).padStart(2, "0");
          const readable = `北京时间 ${beijing.getFullYear()}-${pad(beijing.getMonth() + 1)}-${pad(beijing.getDate())} ${pad(hour)}:${pad(minute)}（${weekday}）`;
          return `${readable} | UTC=${date.toISOString()}`;
        }
        const fallback = new Date(Date.now() + 24 * 3600_000);
        return `北京时间（默认次日同时刻） | UTC=${fallback.toISOString()}`;
      },
    }),
    submit_task: tool({
      description: "提交定时出题任务到调度服务。用户确认时间后调用。",
      inputSchema: submitSchema,
      execute: async ({ trigger_time_utc, prompt }: SubmitArgs) => {
        const result = await deps.appTask.registerTask({
          uid: input.uid,
          task_type: "http",
          payload: {
            uid: input.uid,
            prompt,
            question_count: 1,
            user_email: input.userEmail,
            cc_emails: [],
            incomplete_message: "",
          },
          executor_url: config.taskQuiz.executorUrl,
          async: true,
          trigger_time: trigger_time_utc,
        });
        return `提交成功！task_id=${result.task_id}，状态=${result.status}。到时间后自动出题并邮件通知。`;
      },
    }),
    query_task: tool({
      description: "查询定时任务详情（调度视角）。",
      inputSchema: z.object({ task_id: z.string().describe("任务 ID") }),
      execute: async ({ task_id }: { task_id: string }) => {
        const detail = await deps.appTask.taskDetail(task_id);
        return `任务详情: ${JSON.stringify(detail).slice(0, 500)}`;
      },
    }),
  };
}
