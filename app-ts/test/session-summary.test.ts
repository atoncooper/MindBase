import { describe, it, expect } from "vitest";
import { PromptRegistry } from "../src/agent/prompts/loader.js";
import {
  EMPTY_RESULT,
  SessionSummaryError,
  SessionSummaryService,
} from "../src/services/session-summary.js";
import { MemorySessionSummaryStore } from "../src/repository/memory/session-summaries.js";
import type { SessionSummaryInsert } from "../src/repository/session-summaries.js";
import type {
  ChatMessage,
  ChatSession,
  ChatSessionRepository,
  MessageRepository,
} from "../src/repository/persistence.js";

/**
 * Session summary port (app/routers/session_summary.py + services/session_summary.py):
 * pre-stream validation (404/400), SSE frames (chunk/done/error), persistence and
 * the snake_case/naive-UTC wire shape are the behaviors the frontend contract owns.
 */

const prompts = PromptRegistry.load();

const SESSION = "s-1";
const UID = 7;

function fakeSessions(exists = true): ChatSessionRepository {
  const session: ChatSession = { id: SESSION, uid: UID, createdAt: 0, updatedAt: 0 };
  return {
    get: async (id: string, uid?: number) =>
      exists && id === SESSION && (uid === undefined || uid === UID) ? session : undefined,
  } as unknown as ChatSessionRepository;
}

function msg(id: string, role: "user" | "assistant", content: string, createdAt: number): ChatMessage {
  return { id, sessionId: SESSION, role, content, status: "done", createdAt };
}

const HISTORY = [msg("m1", "user", "什么是闭包？", 1000), msg("m2", "assistant", "闭包是函数与其词法环境的组合。", 2000)];

function fakeMessages(history: ChatMessage[] = HISTORY): MessageRepository {
  return {
    countBySession: async () => history.length,
    recentMessages: async () => history,
  } as unknown as MessageRepository;
}

function serviceWith(
  opts: {
    exists?: boolean;
    history?: ChatMessage[];
    store?: MemorySessionSummaryStore;
    stream?: (args: { system: string; prompt: string; uid: number; sessionId: string }) => AsyncIterable<string>;
  } = {},
) {
  const store = opts.store ?? new MemorySessionSummaryStore();
  const svc = new SessionSummaryService(
    fakeSessions(opts.exists ?? true),
    fakeMessages(opts.history ?? HISTORY),
    store,
    prompts,
    opts.stream ?? (() => (async function* () { yield "总结内容"; })()),
  );
  return { svc, store };
}

async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const f of gen) out.push(f);
  return out;
}

describe("SessionSummaryService.prepare", () => {
  it("会话不存在 → 404", async () => {
    const { svc } = serviceWith({ exists: false });
    await expect(svc.prepare(UID, SESSION)).rejects.toMatchObject({ status: 404 });
  });

  it("会话无消息 → 400", async () => {
    const { svc } = serviceWith({ history: [] });
    await expect(svc.prepare(UID, SESSION)).rejects.toMatchObject({ status: 400 });
  });

  it("构造 system + 会话转写 prompt", async () => {
    const { svc } = serviceWith();
    const prepared = await svc.prepare(UID, SESSION);
    expect(prepared.history).toHaveLength(2);
    expect(prepared.system).toContain("会话总结助手");
    expect(prepared.prompt).toContain("请总结当前会话");
    expect(prepared.prompt).toContain("【用户】");
    expect(prepared.prompt).toContain("闭包是函数与其词法环境的组合。");
  });
});

describe("SessionSummaryService.streamFrames", () => {
  it("流式 chunk → 落库 → done(summary_id, message_count)", async () => {
    const inserted: SessionSummaryInsert[] = [];
    const store = new MemorySessionSummaryStore();
    const originalInsert = store.insert.bind(store);
    store.insert = async (input: SessionSummaryInsert) => {
      inserted.push(input);
      return originalInsert(input);
    };
    const { svc } = serviceWith({
      store,
      stream: () => (async function* () { yield "## 会话主题\n"; yield "讨论闭包"; })(),
    });
    const prepared = await svc.prepare(UID, SESSION);
    const frames = (await collect(svc.streamFrames(UID, SESSION, prepared))) as Array<Record<string, unknown>>;

    expect(frames.map((f) => f.type)).toEqual(["chunk", "chunk", "done"]);
    expect(frames[2].summary_id).toBeTruthy();
    expect(frames[2].message_count).toBe(2);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].content).toBe("## 会话主题\n讨论闭包");
    expect(inserted[0].messageCount).toBe(2);
    expect(inserted[0].firstMessageAt).toBe(1000);
    expect(inserted[0].lastMessageAt).toBe(2000);
  });

  it("模型无输出 → error 帧且不落库", async () => {
    const store = new MemorySessionSummaryStore();
    let inserted = 0;
    const originalInsert = store.insert.bind(store);
    store.insert = async (input: SessionSummaryInsert) => {
      inserted += 1;
      return originalInsert(input);
    };
    const { svc } = serviceWith({ store, stream: () => (async function* () {})() });
    const prepared = await svc.prepare(UID, SESSION);
    const frames = (await collect(svc.streamFrames(UID, SESSION, prepared))) as Array<Record<string, unknown>>;
    expect(frames).toEqual([{ type: "error", message: EMPTY_RESULT }]);
    expect(inserted).toBe(0);
  });

  it("LLM 失败 → error 帧（不抛出、不落库）", async () => {
    const { svc } = serviceWith({
      stream: () => (async function* () {
        yield "部分";
        throw new Error("网关 502");
      })(),
    });
    const prepared = await svc.prepare(UID, SESSION);
    const frames = (await collect(svc.streamFrames(UID, SESSION, prepared))) as Array<Record<string, unknown>>;
    expect(frames[0]).toEqual({ type: "chunk", content: "部分" });
    expect(frames[1]).toEqual({ type: "error", message: "网关 502" });
  });

  it("落库失败 → done(summary_id=null)（内容仍已下发）", async () => {
    const store = new MemorySessionSummaryStore();
    store.insert = async () => {
      throw new Error("mongo down");
    };
    const { svc } = serviceWith({ store, stream: () => (async function* () { yield "总结"; })() });
    const prepared = await svc.prepare(UID, SESSION);
    const frames = (await collect(svc.streamFrames(UID, SESSION, prepared))) as Array<Record<string, unknown>>;
    expect(frames[frames.length - 1]).toEqual({ type: "done", summary_id: null, message_count: 2 });
  });
});

describe("SessionSummaryService.latest / toWire", () => {
  it("无总结 → 404", async () => {
    const { svc } = serviceWith();
    await expect(svc.latest(UID, SESSION)).rejects.toBeInstanceOf(SessionSummaryError);
  });

  it("wire 形状：snake_case + naive-UTC ISO", async () => {
    const store = new MemorySessionSummaryStore();
    const { svc } = serviceWith({ store });
    await store.insert({
      chatSessionId: SESSION,
      uid: UID,
      content: "总结正文",
      messageCount: 2,
      firstMessageAt: 1000,
      lastMessageAt: 2000,
    });
    const doc = await svc.latest(UID, SESSION);
    const wire = svc.toWire(doc);
    expect(wire).toMatchObject({
      summary_id: doc.summaryId,
      chat_session_id: SESSION,
      content: "总结正文",
      message_count: 2,
      first_message_at: "1970-01-01T00:00:01.000",
      last_message_at: "1970-01-01T00:00:02.000",
    });
    expect(wire.created_at).toBeTruthy();
    expect(wire.created_at.endsWith("Z")).toBe(false);
  });
});
