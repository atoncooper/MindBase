import { describe, it, expect } from "vitest";
import { rrfMerge } from "../src/rag/rrf.js";
import { isRetryableError } from "../src/agent/react.js";
import { AgentRuntime } from "../src/tools/runtime.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { defineTool } from "../src/tools/base.js";
import { createDelegateTool } from "../src/tools/harness/delegate.js";
import { AgentLifecycleManager } from "../src/agent/lifecycle.js";
import { inheritScopeFromHistory } from "../src/services/chat.js";
import { ResultCollector, type Source } from "../src/context/types.js";
import { z } from "zod";
import type { Agent } from "../src/agent/types.js";
import type { SseFrame } from "../src/transport/sse.js";
import type { ChatMessage } from "../src/repository/persistence.js";

function ctx() {
  return { uid: 1, chatSessionId: "s1", scope: {}, collector: new ResultCollector() };
}

describe("rrfMerge", () => {
  const doc = (id: string, text = "t") => ({ text, metadata: { chunkId: id } });

  it("fuses two ranked lists with RRF, dedupes and re-ranks", () => {
    const merged = rrfMerge([doc("a"), doc("b"), doc("c")], [doc("b"), doc("x"), doc("a")]);
    const ids = merged.map((m) => m.metadata.chunkId);
    // b: rank2(A)+rank1(B) beats a: rank1(A)+rank3(B)
    expect(ids[0]).toBe("b");
    expect(ids[1]).toBe("a");
    expect(ids).toContain("a");
    expect(ids).toHaveLength(4);
    // scores are descending RRF values
    const scores = merged.map((m) => m.score as number);
    expect(scores[0]).toBeGreaterThan(scores[1]);
  });

  it("handles an empty sparse leg (dense passthrough)", () => {
    const merged = rrfMerge([doc("a"), doc("b")], []);
    expect(merged.map((m) => m.metadata.chunkId)).toEqual(["a", "b"]);
  });
});

describe("isRetryableError", () => {
  it("retryable: connectivity / timeout / rate limit / 5xx", () => {
    for (const msg of [
      "Cannot connect to API: ECONNREFUSED 127.0.0.1:18080",
      "Request timed out after 30000 ms",
      "status code: 429 rate limit exceeded",
      "status code: 502 bad gateway",
      "AI_RetryError: Failed after 3 attempts. Last error: fetch failed",
    ]) {
      expect(isRetryableError(msg), msg).toBe(true);
    }
  });

  it("fatal: auth / bad request / context length", () => {
    for (const msg of [
      "status code: 401 unauthorized",
      "invalid api key provided",
      "status code: 400 invalid request payload",
      "prompt is too long: context length exceeded",
    ]) {
      expect(isRetryableError(msg), msg).toBe(false);
    }
  });
});

describe("tool repeat-call ledger", () => {
  const echo = defineTool({
    name: "echo",
    description: "echo",
    inputSchema: z.object({ text: z.string() }),
    execute: async (args) => `echo:${args.text}`,
  });

  function makeRuntime() {
    const r = new ToolRegistry();
    r.register(echo);
    return new AgentRuntime(() => r.list());
  }

  it("allows up to the limit, then rejects identical calls without executing", async () => {
    const runtime = makeRuntime();
    const c = ctx();
    const def = { name: "echo", execute: echo.execute } as const;
    for (let i = 1; i <= 3; i++) {
      const out = await runtime.execute(def, { text: "same" }, c);
      expect(contentOf(out)).toBe("echo:same");
    }
    const rejected = await runtime.execute(def, { text: "same" }, c);
    expect(contentOf(rejected)).toContain("已调用 3 次");
    // different args are a different ledger key → allowed
    const other = await runtime.execute(def, { text: "different" }, c);
    expect(contentOf(other)).toBe("echo:different");
    // a new turn (new collector) starts a fresh ledger
    const fresh = await runtime.execute(def, { text: "same" }, ctx());
    expect(contentOf(fresh)).toBe("echo:same");
  });

  it("exposes metrics", async () => {
    const runtime = makeRuntime();
    const c = ctx();
    await runtime.execute({ name: "echo", execute: echo.execute }, { text: "x" }, c);
    expect(runtime.monitor().echo.calls).toBe(1);
  });
});

const contentOf = (out: { content: string }) => out.content;

describe("delegate failure short-circuit", () => {
  function lifecycleWith(failCount: number) {
    const lifecycle = new AgentLifecycleManager();
    let calls = 0;
    lifecycle.register("sub", () => ({
      name: "sub",
      description: "t",
      async *run() {
        calls += 1;
        if (calls <= failCount) {
          yield { type: "error", message: "上游挂了" } as SseFrame;
          yield { type: "done" } as SseFrame;
          return;
        }
        yield { type: "chunk", content: "ok" } as SseFrame;
        yield { type: "done" } as SseFrame;
      },
    }) as unknown as Agent);
    return { lifecycle, getCalls: () => calls };
  }

  function makeCtx() {
    return { uid: 1, chatSessionId: "s1", scope: {}, collector: new ResultCollector() };
  }

  it("stops delegating to the same failing sub-agent after 2 failures", async () => {
    const { lifecycle, getCalls } = lifecycleWith(99); // always fails
    const tool = createDelegateTool(lifecycle, [{ name: "sub", description: "t" }]);
    const c = makeCtx();
    const r1 = await tool.execute({ agent: "sub", message: "1" }, c);
    expect(contentText(r1)).toContain("[委托失败]");
    const r2 = await tool.execute({ agent: "sub", message: "2" }, c);
    expect(contentText(r2)).toContain("[委托失败]");
    const r3 = await tool.execute({ agent: "sub", message: "3" }, c);
    expect(contentText(r3)).toContain("已连续失败 2 次");
    expect(getCalls()).toBe(2); // third call never reached the sub-agent
  });

  it("a success resets the failure counter", async () => {
    const { lifecycle } = lifecycleWith(1); // fails once, then succeeds
    const tool = createDelegateTool(lifecycle, [{ name: "sub", description: "t" }]);
    const c = makeCtx();
    await tool.execute({ agent: "sub", message: "1" }, c);
    await tool.execute({ agent: "sub", message: "2" }, c); // succeeds → counter reset
    const r3 = await tool.execute({ agent: "sub", message: "3" }, c);
    expect(contentText(r3)).toContain("ok");
  });
});

const contentText = (out: unknown) => (typeof out === "string" ? out : (out as { content: string }).content);

describe("inheritScopeFromHistory", () => {
  const msg = (over: Partial<ChatMessage>): ChatMessage => ({
    id: "m",
    sessionId: "s",
    role: "user",
    content: "",
    status: "done",
    createdAt: 0,
    ...over,
  });

  it("empty history → empty scope", () => {
    expect(inheritScopeFromHistory([])).toEqual({});
  });

  it("inherits bvids from the latest assistant message with sources", () => {
    const history = [
      msg({ role: "assistant", sources: [{ bvid: "BV1" }, { bvid: "BV2" }] }),
      msg({ role: "user" }),
      msg({ role: "assistant", sources: [{ bvid: "BV3" }, { chunkId: "c" }] }),
      msg({ role: "user" }),
    ];
    expect(inheritScopeFromHistory(history)).toEqual({ bvids: ["BV3"] });
  });

  it("skips assistant messages without sources", () => {
    const history = [msg({ role: "assistant" }), msg({ role: "user", content: "q" })];
    expect(inheritScopeFromHistory(history)).toEqual({});
  });

  it("dedupes bvids", () => {
    const history = [msg({ role: "assistant", sources: [{ bvid: "BV1" }, { bvid: "BV1" }] as Source[] })];
    expect(inheritScopeFromHistory(history)).toEqual({ bvids: ["BV1"] });
  });
});
