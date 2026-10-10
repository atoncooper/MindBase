import { describe, it, expect } from "vitest";
import { MemoryMemoryStore } from "../src/repository/memory/memory-store.js";
import { createSaveMemoryTool } from "../src/tools/memory/index.js";
import { buildMemorySection } from "../src/context/memory.js";
import { createDelegateTool } from "../src/tools/harness/delegate.js";
import { AgentLifecycleManager } from "../src/agent/lifecycle.js";
import { ResultCollector } from "../src/context/types.js";
import type { Agent } from "../src/agent/types.js";
import type { SseFrame } from "../src/transport/sse.js";

function makeCtx(uid?: number) {
  return { uid, chatSessionId: "sess-1", scope: {}, collector: new ResultCollector() };
}

function fakeAgent(frames: SseFrame[], fail = false): Agent {
  return {
    name: "sub",
    description: "fake",
    async *run(_input) {
      if (fail) throw new Error("子 agent 崩了");
      yield* frames;
    },
  };
}

describe("MemoryMemoryStore", () => {
  it("保存并按关键词检索", async () => {
    const store = new MemoryMemoryStore();
    await store.add(1, "用户喜欢 TypeScript");
    await store.add(1, "用户在杭州工作");
    const hits = await store.search(1, "TypeScript");
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain("TypeScript");
  });

  it("中文 2-gram 命中", async () => {
    const store = new MemoryMemoryStore();
    await store.add(1, "用户偏好深色主题");
    const hits = await store.search(1, "主题偏好");
    expect(hits).toHaveLength(1);
  });

  it("按 uid 隔离", async () => {
    const store = new MemoryMemoryStore();
    await store.add(1, "用户喜欢咖啡");
    const hits = await store.search(2, "咖啡");
    expect(hits).toHaveLength(0);
  });

  it("list 按时间倒序", async () => {
    const store = new MemoryMemoryStore();
    await store.add(1, "第一条");
    await new Promise((r) => setTimeout(r, 5));
    await store.add(1, "第二条");
    const all = await store.list(1);
    expect(all[0].content).toBe("第二条");
  });
});

describe("memory 上下文注入", () => {
  it("无 uid / 无记忆时返回空串（不渲染区段）", async () => {
    const store = new MemoryMemoryStore();
    expect(await buildMemorySection(store, undefined, "任意")).toBe("");
    expect(await buildMemorySection(store, 1, "任意")).toBe("");
  });

  it("命中检索时渲染记忆区段", async () => {
    const store = new MemoryMemoryStore();
    await store.add(1, "用户偏好深色主题");
    const section = await buildMemorySection(store, 1, "主题偏好");
    expect(section).toContain("用户长期记忆");
    expect(section).toContain("深色主题");
  });

  it("检索未命中回退最近记忆", async () => {
    const store = new MemoryMemoryStore();
    await store.add(1, "用户在杭州工作");
    const section = await buildMemorySection(store, 1, "完全无关的查询词");
    expect(section).toContain("杭州");
  });
});

describe("save_memory tool", () => {
  it("需要 uid", async () => {
    const store = new MemoryMemoryStore();
    const tool = createSaveMemoryTool(store);
    const out = await tool.execute({ content: "测试" }, makeCtx(undefined));
    expect(typeof out === "string" ? out : out.content).toContain("没有用户身份");
  });

  it("保存后可被上下文召回", async () => {
    const store = new MemoryMemoryStore();
    const tool = createSaveMemoryTool(store);
    const ctx = makeCtx(42);
    await tool.execute({ content: "用户偏好深色主题", tags: ["偏好"] }, ctx);
    const section = await buildMemorySection(store, 42, "主题偏好");
    expect(section).toContain("深色主题");
  });
});

describe("delegate_to_agent 基建（供后续子 agent 使用）", () => {
  function makeLifecycle() {
    const lifecycle = new AgentLifecycleManager();
    lifecycle.register("sub", () =>
      fakeAgent([
        { type: "chunk", content: "子 agent 结果" },
        { type: "sources", sources: [{ chunkId: "m1" }] },
        { type: "done" },
      ]),
    );
    lifecycle.register("broken", () => fakeAgent([], true));
    return lifecycle;
  }

  it("委托成功：内容回传 + sources 汇入 collector", async () => {
    const lifecycle = makeLifecycle();
    const tool = createDelegateTool(lifecycle, [{ name: "sub", description: "测试子 agent" }]);
    const ctx = makeCtx(42);
    const out = await tool.execute({ agent: "sub", message: "干活" }, ctx);
    const content = typeof out === "string" ? out : out.content;
    expect(content).toContain("子 agent 结果");
    expect(ctx.collector.sources).toEqual([{ chunkId: "m1" }]);
  });

  it("委托不存在的 agent 返回错误文本", async () => {
    const lifecycle = makeLifecycle();
    const tool = createDelegateTool(lifecycle, [{ name: "sub", description: "测试" }]);
    const out = await tool.execute({ agent: "nope", message: "x" }, makeCtx(42));
    const content = typeof out === "string" ? out : out.content;
    expect(content).toContain("不存在");
  });

  it("子 agent 抛错时收敛为失败文本（不中断主循环）", async () => {
    const lifecycle = makeLifecycle();
    const tool = createDelegateTool(lifecycle, [{ name: "broken", description: "会崩的" }]);
    const out = await tool.execute({ agent: "broken", message: "x" }, makeCtx(42));
    const content = typeof out === "string" ? out : out.content;
    expect(content).toContain("[委托失败]");
  });
});

describe("lifecycle 可重入", () => {
  it("invokeReentrant 在会话锁被持有时仍可执行（不死锁）", async () => {
    const m = new AgentLifecycleManager();
    let releaseFirst!: () => void;
    let blocked = true;
    m.register("main", () => ({
      name: "main",
      description: "t",
      async *run() {
        if (blocked) {
          blocked = false;
          await new Promise<void>((r) => {
            releaseFirst = r;
          });
        }
        yield { type: "done" };
      },
    }));
    m.register("sub", () => fakeAgent([{ type: "chunk", content: "子 agent 结果" }, { type: "done" }]));

    // The main agent holds the session lock of s1
    const first = m.stream("main", "s1", { query: "q", scope: {} });
    void (async () => {
      for await (const _f of first) void _f;
    })().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));

    // Re-entrant calls for the same session must run immediately (delegate scenario)
    const result = await Promise.race([
      m.invokeReentrant("sub", "s1", { query: "q", scope: {} }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("deadlock")), 1000)),
    ]);
    expect(result.content).toBe("子 agent 结果");
    releaseFirst();
  }, 10_000);
});
