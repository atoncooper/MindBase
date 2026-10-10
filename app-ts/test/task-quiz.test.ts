import { describe, it, expect, afterEach } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { buildServer } from "../src/transport/http/server.js";
import type { RAGService } from "../src/rag/service.js";
import type { ChatService } from "../src/services/chat.js";
import type { AgentHarness } from "../src/harness/app.js";
import type { SessionDocumentRepository } from "../src/repository/session-docs.js";
import { MemoryTaskQuizDocStore } from "../src/repository/memory/task-quiz-docs.js";
import { TaskQuizGenerationService } from "../src/services/task-quiz-generation.js";
import { PromptRegistry } from "../src/agent/prompts/loader.js";
import type { AppQuizClient } from "../src/services/app-quiz-client.js";
import type { AppTaskClient } from "../src/services/app-task-client.js";
import type { AppAuthClient } from "../src/services/app-auth-client.js";

// ---------- fakes ----------

function fakeAppTask(registered: Array<Record<string, unknown>> = []) {
  return {
    registerTask: async (body: Record<string, unknown>) => {
      registered.push(body);
      return { task_id: "t-123", status: "pending" };
    },
    taskDetail: async () => ({}),
    sendEmail: async (body: Record<string, unknown>) => {
      registered.push({ __email: body });
    },
    completeTask: async (taskId: string, status: string) => {
      registered.push({ __complete: { taskId, status } });
    },
  } as unknown as AppTaskClient;
}

function fakeAppAuth(email: string | null) {
  return {
    getUserEmail: async (uid: number) => {
      if (email === null) throw Object.assign(new Error("用户不存在"), { status: 404 });
      return email;
    },
  } as unknown as AppAuthClient;
}

function fakeAppQuiz() {
  return {
    createTaskQuizRow: async () => {},
    markTaskQuizGenerated: async () => {},
  } as unknown as AppQuizClient;
}

const QUESTIONS = [
  {
    question: "1+1=?",
    question_type: "fill_blank" as const,
    options: null,
    answer: "2",
    difficulty: "easy" as const,
    answer_time_limit_seconds: 600,
  },
];

function makeGeneration(docs: MemoryTaskQuizDocStore) {
  const gen = new TaskQuizGenerationService({ docs, appQuiz: fakeAppQuiz(), appTask: fakeAppTask(), prompts: PromptRegistry.load() });
  // stub the LLM step (the real one goes through generateObject + gateway)
  (gen as unknown as { generateQuestions: (i: unknown) => Promise<typeof QUESTIONS> }).generateQuestions =
    async () => QUESTIONS;
  return gen;
}

// mock model: step 1 = tool-call submit_task, step 2 = final text
const metadata = { id: "r1", modelId: "mock", timestamp: new Date() };
const makeChatModel = () =>
  new MockLanguageModelV2({
    doStream: (() => {
      let call = 0;
      return async () => {
        const current = call++;
        const chunks: LanguageModelV2StreamPart[] =
          current === 0
            ? [
                { type: "stream-start", warnings: [] },
                { type: "response-metadata", ...metadata },
                { type: "tool-call", toolCallId: "c1", toolName: "submit_task", input: JSON.stringify({ trigger_time_utc: "2026-10-10T02:00:00.000Z", prompt: "数学" }) },
                { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
              ]
            : [
                { type: "stream-start", warnings: [] },
                { type: "response-metadata", ...metadata },
                { type: "text-start", id: "t0" },
                { type: "text-delta", id: "t0", delta: "已提交" },
                { type: "text-end", id: "t0" },
                { type: "finish", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } },
              ];
        return { stream: simulateReadableStream({ initialDelayInMs: 5, chunks }) };
      };
    })(),
  });

// ---------- server fixture ----------

describe("task-quiz routes", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  const fakeRag = {
    getCollectionStats: async () => ({ collectionName: "c", totalChunks: 0, totalVideos: 0, available: false }),
  } as unknown as RAGService;
  const fakeHarness = { runtimeStatus: () => ({}) } as unknown as AgentHarness;
  const fakeDocs: SessionDocumentRepository = {
    save: async () => ({ id: "1", sessionId: "s", filename: "f", sizeBytes: 0, chunkCount: 0, createdAt: 0 }),
    list: async () => [],
    search: async () => [],
    deleteBySession: async () => 0,
  };
  const chat = {} as ChatService;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const build = async (opts?: { authEmail?: string | null }) => {
    const docs = new MemoryTaskQuizDocStore();
    const registered: Array<Record<string, unknown>> = [];
    app = await buildServer({
      chat,
      harness: fakeHarness,
      rag: fakeRag,
      sessionDocs: fakeDocs,
      taskQuiz: {
        generation: makeGeneration(docs),
        appTask: fakeAppTask(registered),
        appAuth: fakeAppAuth(opts?.authEmail === undefined ? "user@test.dev" : opts.authEmail),
        agentModel: makeChatModel(),
      },
    } as Parameters<typeof buildServer>[0]);
    return { docs, registered };
  };

  it("POST /task-quiz/register validates email presence and forwards to app-task", async () => {
    // 400 when the profile has no email
    await build({ authEmail: "" });
    const emptyEmail = await app!.inject({
      method: "POST",
      url: "/task-quiz/register",
      headers: { "x-uid": "7" },
      payload: { prompt: "数学", trigger_time: new Date(Date.now() + 3600_000).toISOString() },
    });
    expect(emptyEmail.statusCode).toBe(400);
    expect(emptyEmail.json().detail).toContain("email");

    // 400 for a past trigger_time
    await build();
    const past = await app!.inject({
      method: "POST",
      url: "/task-quiz/register",
      headers: { "x-uid": "7" },
      payload: { prompt: "数学", trigger_time: "2020-01-01T00:00:00Z" },
    });
    expect(past.statusCode).toBe(400);
    expect(past.json().detail).toContain("触发时间");
  });

  it("POST /task-quiz/register forwards the payload to app-task with resolved email", async () => {
    const { registered } = await build();
    const ok = await app!.inject({
      method: "POST",
      url: "/task-quiz/register",
      headers: { "x-uid": "7" },
      payload: {
        prompt: "数学",
        difficulty: "medium",
        question_count: 2,
        trigger_time: new Date(Date.now() + 3600_000).toISOString(),
        cc_emails: ["cc@test.dev"],
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ task_id: "t-123", status: "pending" });
    const reg = registered.find((r) => (r as { task_type?: string }).task_type === "http");
    expect(reg).toMatchObject({ uid: "7", task_type: "http", async: true });
    expect((reg as { payload: { user_email: string; question_count: number } }).payload).toMatchObject({
      user_email: "user@test.dev",
      question_count: 2,
    });
  });

  it("POST /internal/quiz/generate-llm returns 202 and the pipeline settles to ready", async () => {
    const { docs } = await build();
    const res = await app!.inject({
      method: "POST",
      url: "/internal/quiz/generate-llm",
      headers: { "x-task-id": "task-1", apikey: "x" },
      payload: { prompt: "英语阅读", uid: 7, difficulty: "easy", question_count: 1, user_email: "u@t.dev", cc_emails: [] },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "generating" });

    for (let i = 0; i < 50 && (await docs.get("task-1"))?.status !== "ready"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const doc = await docs.get("task-1");
    expect(doc?.status).toBe("ready");
    expect(doc?.questions).toHaveLength(1);

    // idempotent re-trigger returns ready + quiz
    const again = await app!.inject({
      method: "POST",
      url: "/internal/quiz/generate-llm",
      headers: { "x-task-id": "task-1" },
      payload: { prompt: "英语阅读", uid: 7 },
    });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toMatchObject({ status: "ready" });

    const missingTask = await app!.inject({
      method: "POST",
      url: "/internal/quiz/generate-llm",
      payload: { prompt: "x" },
    });
    expect(missingTask.statusCode).toBe(400);
  });

  it("GET /internal/quiz/status/:task_id mirrors the status contract", async () => {
    const { docs } = await build();
    const unknown = await app!.inject({ method: "GET", url: "/internal/quiz/status/nope" });
    expect(unknown.json()).toEqual({ status: "generating" });

    await docs.markGenerating({ task_id: "t2", uid: 7 });
    await docs.markFailed("t2", "boom");
    const failed = await app!.inject({ method: "GET", url: "/internal/quiz/status/t2" });
    expect(failed.json()).toEqual({ status: "failed", error: "boom" });

    await docs.deleteIfFailed("t2");
    await docs.markGenerating({ task_id: "t2", uid: 7 });
    await docs.markReady("t2", QUESTIONS, "easy");
    const ready = await app!.inject({ method: "GET", url: "/internal/quiz/status/t2" });
    expect(ready.json()).toMatchObject({ status: "ready", quiz: { questions: [{ answer: "2" }] } });
  });

  it("POST /task-quiz/chat streams simple frames (chunk/tool/done) and registers the task", async () => {
    const { registered } = await build();
    const res = await app!.inject({
      method: "POST",
      url: "/task-quiz/chat",
      headers: { "x-uid": "7" },
      payload: { message: "帮我安排一个数学任务" },
    });
    expect(res.statusCode).toBe(200);
    const frames = res.body
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
    const types = frames.map((f) => f.type);
    expect(types).toContain("tool");
    expect(types).toContain("chunk");
    expect(types[types.length - 1]).toBe("done");
    const submit = registered.find((r) => (r as { task_type?: string }).task_type === "http");
    expect(submit).toMatchObject({ uid: 7, async: true });

    const noAuth = await app!.inject({ method: "POST", url: "/task-quiz/chat", payload: { message: "hi" } });
    expect(noAuth.statusCode).toBe(401);
  });
});
