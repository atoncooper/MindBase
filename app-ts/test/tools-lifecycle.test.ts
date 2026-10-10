import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../src/tools/registry.js";
import { AgentRuntime } from "../src/tools/runtime.js";
import { defineTool } from "../src/tools/base.js";
import { ResultCollector } from "../src/context/types.js";
import { AgentLifecycleManager } from "../src/agent/lifecycle.js";
import type { Agent, AgentInvokeInput } from "../src/agent/types.js";
import type { SseFrame } from "../src/transport/sse.js";

const echoTool = defineTool({
  name: "echo",
  description: "echo",
  inputSchema: z.object({ text: z.string() }),
  async execute(args) {
    return {
      content: args.text,
      sources: [{ chunkId: "c1", bvid: "BV1" }],
    };
  },
});

const failingTool = defineTool({
  name: "boom",
  description: "always fails",
  inputSchema: z.object({}),
  async execute() {
    throw new Error("爆炸了");
  },
});

function makeCtx() {
  return {
    uid: 42,
    scope: {},
    collector: new ResultCollector(),
  };
}

describe("ToolRegistry", () => {
  it("注册与查询", () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    expect(r.get("echo")).toBeDefined();
    expect(r.names()).toEqual(["echo"]);
  });

  it("重复注册抛错", () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    expect(() => r.register(echoTool)).toThrow(/duplicate/);
  });
});

describe("AgentRuntime", () => {
  it("正常执行并收集 sources", async () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    const runtime = new AgentRuntime(() => r.list());
    const ctx = makeCtx();
    const out = await runtime.execute(r.get("echo")!, { text: "hello" }, ctx);
    expect(out.content).toBe("hello");
    expect(ctx.collector.sources).toEqual([{ chunkId: "c1", bvid: "BV1" }]);
  });

  it("工具异常被隔离为错误文本", async () => {
    const r = new ToolRegistry();
    r.register(failingTool);
    const runtime = new AgentRuntime(() => r.list());
    const out = await runtime.execute(r.get("boom")!, {}, makeCtx());
    expect(out.content).toContain("工具执行失败");
    expect(out.content).toContain("爆炸了");
    expect(runtime.monitor()["boom"].errors).toBe(1);
  });

  it("buildSdkTools 生成 AI SDK tool 表", () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    const runtime = new AgentRuntime(() => r.list());
    const tools = runtime.buildSdkTools(makeCtx());
    expect(Object.keys(tools)).toEqual(["echo"]);
  });
});

function fakeAgent(frames: SseFrame[], fail = false): Agent {
  return {
    name: "main",
    description: "test",
    async *run(_input: AgentInvokeInput) {
      if (fail) throw new Error("agent 崩溃");
      yield* frames;
    },
  };
}

describe("AgentLifecycleManager", () => {
  it("正常流透传并记录成功", async () => {
    const m = new AgentLifecycleManager();
    m.register("main", () => fakeAgent([{ type: "chunk", content: "hi" }, { type: "done" }]));
    const frames: SseFrame[] = [];
    for await (const f of m.stream("main", "s1", { query: "q", scope: {} })) frames.push(f);
    expect(frames.map((f) => f.type)).toEqual(["chunk", "done"]);
    expect(m.breakerState("main")).toBe("closed");
  });

  it("异常转 error + done 帧", async () => {
    const m = new AgentLifecycleManager();
    m.register("main", () => fakeAgent([], true));
    const frames: SseFrame[] = [];
    for await (const f of m.stream("main", "s1", { query: "q", scope: {} })) frames.push(f);
    expect(frames[0].type).toBe("error");
    expect(frames[1].type).toBe("done");
  });

  it("未注册 agent 报错", async () => {
    const m = new AgentLifecycleManager();
    const frames: SseFrame[] = [];
    for await (const f of m.stream("nope", "s1", { query: "q", scope: {} })) frames.push(f);
    expect(frames[0].type).toBe("error");
  });

  it("同一 session 串行执行", async () => {
    const m = new AgentLifecycleManager();
    const order: string[] = [];
    let releaseFirst!: () => void;
    let blocked = true;
    m.register("main", () => ({
      name: "main",
      description: "t",
      async *run() {
        order.push("start");
        if (blocked) {
          // Only the first call simulates holding the lock and stalling
          blocked = false;
          await new Promise<void>((r) => {
            releaseFirst = r;
          });
        }
        order.push("end");
        yield { type: "done" };
      },
    }));

    const first = m.stream("main", "s1", { query: "q", scope: {} });
    // Fully consume the first stream in the background (it stalls inside the agent until releaseFirst is called)
    void (async () => {
      for await (const _f of first) void _f;
    })().catch(() => undefined);

    const secondFrames: SseFrame[] = [];
    const second = (async () => {
      for await (const f of m.stream("main", "s1", { query: "q", scope: {} })) {
        secondFrames.push(f);
      }
    })();

    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(["start"]); // The second call is blocked by the lock
    releaseFirst();
    await second;
    expect(order).toEqual(["start", "end", "start", "end"]);
    expect(secondFrames.map((f) => f.type)).toEqual(["done"]);
  }, 15_000);
});
