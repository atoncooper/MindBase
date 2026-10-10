import { describe, it, expect, vi } from "vitest";
import { MemoryAgentContextStore } from "../src/repository/memory/agent-context.js";
import { ContextCompressionService } from "../src/services/context-compression.js";
import { buildAgentContextSections } from "../src/agent/context-sections.js";
import { PromptRegistry } from "../src/agent/prompts/loader.js";
import {
  MemoryChatSessionRepository,
  MemoryMessageRepository,
} from "../src/repository/memory/chat-store.js";
import { createDelegateTool } from "../src/tools/harness/delegate.js";
import { AgentLifecycleManager } from "../src/agent/lifecycle.js";
import type { Agent } from "../src/agent/types.js";
import type { SseFrame } from "../src/transport/sse.js";
import type { ToolOutput } from "../src/tools/base.js";
import { ResultCollector } from "../src/context/types.js";

function ctx(uid?: number) {
  return { uid, chatSessionId: "s1", scope: {}, collector: new ResultCollector() };
}

describe("MemoryAgentContextStore isolation", () => {
  it("same session, different agents → isolated buckets", async () => {
    const store = new MemoryAgentContextStore();
    await store.append("s1", "note", { role: "user", content: "整理笔记任务", createdAt: 1 });
    await store.append("s1", "code", { role: "user", content: "写代码任务", createdAt: 2 });
    const noteCtx = await store.recent("s1", "note", 10);
    const codeCtx = await store.recent("s1", "code", 10);
    expect(noteCtx).toHaveLength(1);
    expect(noteCtx[0].content).toBe("整理笔记任务");
    expect(codeCtx[0].content).toBe("写代码任务");
  });

  it("same agent, different sessions → isolated buckets", async () => {
    const store = new MemoryAgentContextStore();
    await store.append("s1", "note", { role: "user", content: "会话1任务", createdAt: 1 });
    await store.append("s2", "note", { role: "user", content: "会话2任务", createdAt: 2 });
    expect((await store.recent("s1", "note", 10))[0].content).toBe("会话1任务");
    expect((await store.recent("s2", "note", 10))[0].content).toBe("会话2任务");
  });

  it("summary is per bucket; trim keeps last N; clear by session/agent", async () => {
    const store = new MemoryAgentContextStore();
    for (let i = 0; i < 5; i++) {
      await store.append("s1", "note", { role: "user", content: `t${i}`, createdAt: i });
    }
    await store.saveSummary("s1", "note", { summary: "S", summarizedCount: 3, updatedAt: 1 });
    expect((await store.getSummary("s1", "note"))?.summarizedCount).toBe(3);
    expect(await store.getSummary("s1", "code")).toBeUndefined();

    await store.trim("s1", "note", 2);
    expect(await store.countEntries("s1", "note")).toBe(2);
    expect((await store.listEntries("s1", "note", 0, 10)).map((e) => e.content)).toEqual(["t3", "t4"]);

    await store.append("s1", "code", { role: "user", content: "x", createdAt: 9 });
    expect(await store.clear("s1", "note")).toBe(1);
    expect(await store.countEntries("s1", "note")).toBe(0);
    expect(await store.countEntries("s1", "code")).toBe(1);
    expect(await store.clear("s1")).toBe(1);
    expect(await store.countEntries("s1", "code")).toBe(0);
  });
});

describe("per-agent compression", () => {
  function makeService(summarize: (s: string, p: string) => Promise<string>) {
    const prompts = PromptRegistry.load();
    return new ContextCompressionService(
      new MemoryChatSessionRepository(),
      new MemoryMessageRepository(),
      prompts,
      summarize,
    );
  }

  it("compresses an agent's own entries incrementally and trims raw entries", async () => {
    const store = new MemoryAgentContextStore();
    for (let i = 0; i < 5; i++) {
      await store.append("s1", "note", { role: "user", content: `任务 ${i}`, createdAt: i });
      await store.append("s1", "note", { role: "assistant", content: `结果 ${i}`, createdAt: i });
    }
    // 10 entries, target = 10-6 = 4 ≥ threshold 4
    const summarize = vi.fn().mockResolvedValue("- 之前整理过 4 份笔记");
    const svc = makeService(summarize);
    const saved = await svc.maybeCompressAgent("s1", "note", store);
    expect(saved?.summarizedCount).toBe(4);
    expect(summarize.mock.calls[0][1]).toContain("任务 0");
    expect((await store.getSummary("s1", "note"))?.summary).toContain("4 份笔记");
    // trim keeps only the recent window raw
    expect(await store.countEntries("s1", "note")).toBe(6);

    // second run: below threshold again → no call
    expect(await svc.maybeCompressAgent("s1", "note", store)).toBeNull();
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("scheduleAgent dedupes concurrent runs per session:agent", async () => {
    const store = new MemoryAgentContextStore();
    for (let i = 0; i < 5; i++) {
      await store.append("s1", "note", { role: "user", content: `t${i}`, createdAt: i });
      await store.append("s1", "note", { role: "assistant", content: `r${i}`, createdAt: i });
    }
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const summarize = vi.fn().mockImplementation(() => gate.then(() => "S"));
    const svc = makeService(summarize);

    svc.scheduleAgent("s1", "note", store);
    svc.scheduleAgent("s1", "note", store);
    release();
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
  });
});

describe("buildAgentContextSections", () => {
  it("empty when neither summary exists", () => {
    expect(buildAgentContextSections(undefined, undefined)).toBe("");
  });

  it("renders own + shared sections with pollution-control wording", () => {
    const out = buildAgentContextSections(
      { summary: "自身摘要", summarizedCount: 4, updatedAt: 1 },
      { summary: "共享摘要", summarizedCount: 10, updatedAt: 2 },
    );
    expect(out).toContain("本任务上下文");
    expect(out).toContain("自身摘要");
    expect(out).toContain("共享上下文");
    expect(out).toContain("共享摘要");
    // shared section is labelled as background-only (read-only for sub-agents)
    expect(out).toContain("仅供参考");
  });
});

describe("delegate return truncation (shared-context pollution control)", () => {
  function agentReturning(content: string): Agent {
    return {
      name: "sub",
      description: "t",
      async *run() {
        yield { type: "chunk", content } as SseFrame;
        yield { type: "done" } as SseFrame;
      },
    };
  }

  it("long sub-agent result flows back truncated", async () => {
    const lifecycle = new AgentLifecycleManager();
    lifecycle.register("sub", () => agentReturning("长".repeat(20000)));
    const tool = createDelegateTool(lifecycle, [{ name: "sub", description: "t" }]);
    const out = (await tool.execute({ agent: "sub", message: "干活" }, ctx(1))) as ToolOutput;
    const content = typeof out === "string" ? out : out.content;
    expect(content.length).toBeLessThan(7000);
    expect(content).toContain("已截断");
  });
});
