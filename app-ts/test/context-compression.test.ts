import { describe, it, expect, vi } from "vitest";
import {
  MemoryChatSessionRepository,
  MemoryMessageRepository,
} from "../src/repository/memory/chat-store.js";
import { ContextCompressionService } from "../src/services/context-compression.js";
import { buildConversationSection } from "../src/context/conversation.js";
import { PromptRegistry } from "../src/agent/prompts/loader.js";

function makeStubs() {
  const sessions = new MemoryChatSessionRepository();
  const messages = new MemoryMessageRepository();
  return { sessions, messages };
}

/** Seed n turns (user + finalized assistant) into the message repo. */
async function seedTurns(messages: MemoryMessageRepository, sessionId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const { assistantMsg } = await messages.beginTurn(sessionId, `用户问题 ${i}`);
    await messages.appendChunk(assistantMsg.id, `回答内容 ${i}`);
    await messages.finalizeTurn(assistantMsg.id, { status: "done" });
  }
}

function makeService(
  sessions: MemoryChatSessionRepository,
  messages: MemoryMessageRepository,
  summarize: (system: string, prompt: string) => Promise<string>,
) {
  const prompts = PromptRegistry.load();
  return new ContextCompressionService(sessions, messages, prompts, summarize);
}

describe("persistence ports (memory)", () => {
  it("summary roundtrip per session", async () => {
    const { sessions } = makeStubs();
    expect(await sessions.getSummary("s1")).toBeUndefined();
    await sessions.saveSummary("s1", { summary: "摘要A", summarizedCount: 6, updatedAt: 1 });
    await sessions.saveSummary("s2", { summary: "摘要B", summarizedCount: 2, updatedAt: 2 });
    expect((await sessions.getSummary("s1"))?.summary).toBe("摘要A");
    expect((await sessions.getSummary("s2"))?.summarizedCount).toBe(2);
  });

  it("countDone excludes pending/failed; listDone paginates in createdAt order", async () => {
    const { messages } = makeStubs();
    await seedTurns(messages, "s1", 3);
    // aborted turn: the user message is done, only the assistant placeholder stays pending
    const { assistantMsg } = await messages.beginTurn("s1", "写一半");
    void assistantMsg;
    expect(await messages.countDone("s1")).toBe(7);
    const page = await messages.listDone("s1", 0, 2);
    expect(page.map((m) => m.content)).toEqual(["用户问题 0", "回答内容 0"]);
    const page2 = await messages.listDone("s1", 4, 10);
    expect(page2.map((m) => m.content)).toEqual(["用户问题 2", "回答内容 2", "写一半"]);
  });
});

describe("ContextCompressionService", () => {
  it("skips when below threshold", async () => {
    const { sessions, messages } = makeStubs();
    await seedTurns(messages, "s1", 3); // 6 done messages, target=6-6=0 → nothing to compress
    const summarize = vi.fn().mockResolvedValue("S");
    const svc = makeService(sessions, messages, summarize);
    expect(await svc.maybeCompress("s1")).toBeNull();
    expect(summarize).not.toHaveBeenCalled();
  });

  it("compresses [0, total-recentKeep) incrementally and records summarizedCount", async () => {
    const { sessions, messages } = makeStubs();
    await seedTurns(messages, "s1", 5); // 10 done, target = 10-6 = 4 ≥ threshold 4
    const summarize = vi.fn().mockResolvedValue("- 用户在调试 RAG 检索");
    const svc = makeService(sessions, messages, summarize);

    const saved = await svc.maybeCompress("s1");
    expect(summarize).toHaveBeenCalledTimes(1);
    // prompt contains previous summary header and the first-turn content
    expect(summarize.mock.calls[0][1]).toContain("已有摘要");
    expect(summarize.mock.calls[0][1]).toContain("用户问题 0");
    expect(saved).toEqual({ summary: "- 用户在调试 RAG 检索", summarizedCount: 4, updatedAt: expect.any(Number) });
    expect((await sessions.getSummary("s1"))?.summarizedCount).toBe(4);

    // adding fewer than threshold new messages → no recompression
    await seedTurns(messages, "s1", 1); // 12 done, target=6, 6-4=2 < 4
    expect(await svc.maybeCompress("s1")).toBeNull();
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("incremental merge: second compression passes previous summary as context", async () => {
    const { sessions, messages } = makeStubs();
    await seedTurns(messages, "s1", 5);
    const summarize = vi.fn().mockResolvedValue("S1");
    const svc = makeService(sessions, messages, summarize);
    await svc.maybeCompress("s1");

    await seedTurns(messages, "s1", 3); // 16 done, target=10, 10-4=6 ≥ 4
    summarize.mockResolvedValue("S2");
    await svc.maybeCompress("s1");
    expect(summarize.mock.calls[1][1]).toContain("已有摘要\nS1");
    expect((await sessions.getSummary("s1"))?.summary).toBe("S2");
    expect((await sessions.getSummary("s1"))?.summarizedCount).toBe(10);
  });

  it("schedule deduplicates concurrent runs for the same session", async () => {
    const { sessions, messages } = makeStubs();
    await seedTurns(messages, "s1", 5);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const summarize = vi.fn().mockImplementation(() => gate.then(() => "S"));
    const svc = makeService(sessions, messages, summarize);

    svc.schedule("s1");
    svc.schedule("s1");
    svc.schedule("s1");
    release();
    // wait for the single in-flight run to settle
    await vi.waitFor(() => {
      expect(summarize).toHaveBeenCalledTimes(1);
    });
  });
});

describe("buildConversationSection", () => {
  it("empty when no summary", async () => {
    const { sessions } = makeStubs();
    expect(await buildConversationSection((id) => sessions.getSummary(id), "s1")).toBe("");
    expect(await buildConversationSection((id) => sessions.getSummary(id), undefined)).toBe("");
  });

  it("renders summary section", async () => {
    const { sessions } = makeStubs();
    await sessions.saveSummary("s1", { summary: "- 用户在调试 RAG", summarizedCount: 4, updatedAt: 1 });
    const section = await buildConversationSection((id) => sessions.getSummary(id), "s1");
    expect(section).toContain("对话上下文");
    expect(section).toContain("用户在调试 RAG");
  });
});
