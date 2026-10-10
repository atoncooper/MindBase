import { describe, it, expect } from "vitest";
import { simulateReadableStream, tool, type LanguageModelV2StreamPart } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { z } from "zod";
import { createReactAgent, isContextLengthError } from "../src/agent/react.js";
import { defineTool } from "../src/tools/base.js";
import type { AgentRuntime } from "../src/tools/runtime.js";
import type { SseFrame } from "../src/transport/sse.js";

/**
 * Agent-loop hardening:
 *  - context-length exhaustion → history trimmed + one retry (reset frame), not fatal
 *  - empty answer (loop ended without text/interactions/artifacts) → explicit error frame
 *  - step frames carry compact args + execution duration
 */

const metadata = { id: "r1", modelId: "mock", timestamp: new Date() };

const echoTool = tool({
  description: "echo",
  inputSchema: z.object({ query: z.string() }),
  execute: async () => "回声",
});

const sleepTool = defineTool({
  name: "sleep_tool",
  description: "sleep",
  inputSchema: z.object({}),
  execute: async () => {
    await new Promise((r) => setTimeout(r, 30));
    return "睡醒了";
  },
});

function makeAgent(model: MockLanguageModelV2, extraTools: Record<string, unknown> = {}) {
  const runtime = {
    buildSdkTools: (ctx: unknown) => ({
      echo_tool: echoTool,
      ...extraTools,
    }),
  } as unknown as AgentRuntime;
  return createReactAgent({
    name: "main",
    description: "main",
    runtime,
    toolNames: ["echo_tool"],
    purpose: "chat",
    buildSystemPrompt: async () => "sys",
    model,
  });
}

const base = { id: "r1", modelId: "mock", timestamp: new Date() };

describe("agent loop: context-length fallback", () => {
  it("trims the older half of history and retries once instead of failing", async () => {
    const model = new MockLanguageModelV2({
      doStream: (() => {
        let call = 0;
        return async (options: { prompt: { messages: unknown[] } }) => {
          const current = call++;
          const chunks: LanguageModelV2StreamPart[] =
            current === 0
              ? [
                  { type: "stream-start", warnings: [] },
                  { type: "response-metadata", ...base },
                  { type: "error", error: new Error("This model's maximum context length is 8192 tokens, prompt is too long") },
                ]
              : [
                  { type: "stream-start", warnings: [] },
                  { type: "response-metadata", ...base },
                  { type: "text-start", id: "t0" },
                  { type: "text-delta", id: "t0", delta: "裁剪后回答成功" },
                  { type: "text-end", id: "t0" },
                  { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
                ];
          void options;
          return { stream: simulateReadableStream({ initialDelayInMs: 10, chunks }) };
        };
      })(),
    });
    const agent = makeAgent(model);
    const frames: SseFrame[] = [];
    for await (const frame of agent.run({
      query: "当前问题",
      scope: {},
      history: [
        { role: "user", content: "旧问题1" },
        { role: "assistant", content: "旧回答1" },
        { role: "user", content: "旧问题2" },
        { role: "assistant", content: "旧回答2" },
      ],
    })) {
      frames.push(frame);
    }

    // reset + successful retry, no terminal error frame
    expect(frames.some((f) => f.type === "reset")).toBe(true);
    expect(frames.some((f) => f.type === "chunk" && f.content === "裁剪后回答成功")).toBe(true);
    expect(frames.some((f) => f.type === "error")).toBe(false);

    // the retry ran with a trimmed history (4 → 2 entries); prompt = system + history + user query
    expect(model.doStreamCalls.length).toBe(2);
    const firstMessages = model.doStreamCalls[0].prompt as unknown[];
    const secondMessages = model.doStreamCalls[1].prompt as unknown[];
    expect(firstMessages.length).toBe(6);
    expect(secondMessages.length).toBe(4);
  });

  it("isContextLengthError matches provider wordings", () => {
    expect(isContextLengthError("prompt is too long: 200000 tokens > 8192 maximum")).toBe(true);
    expect(isContextLengthError("This model's maximum context length is exceeded")).toBe(true);
    expect(isContextLengthError("connection refused")).toBe(false);
  });
});

describe("agent loop: empty-answer guard", () => {
  it("loop ending without text/interactions/artifacts → explicit error frame", async () => {
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: 10,
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", ...base },
            { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } },
          ] as LanguageModelV2StreamPart[],
        }),
      }),
    });
    const agent = makeAgent(model);
    const frames: SseFrame[] = [];
    for await (const frame of agent.run({ query: "问", scope: {}, history: [] })) {
      frames.push(frame);
    }
    const errorFrame = frames.find((f) => f.type === "error");
    expect(errorFrame).toBeDefined();
    if (errorFrame?.type === "error") expect(errorFrame.message).toContain("未返回有效内容");
  });
});

describe("agent loop: step frame observability", () => {
  it("step start carries compact args, done carries durationMs", async () => {
    const sleepTool = defineTool({
      name: "echo_tool",
      description: "echo",
      inputSchema: z.object({ query: z.string() }),
      execute: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return "回声";
      },
    });
    const model = new MockLanguageModelV2({
      doStream: (() => {
        let call = 0;
        return async () => {
          const current = call++;
          const chunks: LanguageModelV2StreamPart[] =
            current === 0
              ? [
                  { type: "stream-start", warnings: [] },
                  { type: "response-metadata", ...base },
                  { type: "tool-call", toolCallId: "c1", toolName: "echo_tool", input: JSON.stringify({ query: "x".repeat(200) }) },
                  { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
                ]
              : [
                  { type: "stream-start", warnings: [] },
                  { type: "response-metadata", ...base },
                  { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
                ];
          return { stream: simulateReadableStream({ initialDelayInMs: 10, chunks }) };
        };
      })(),
    });
    const runtime = {
      buildSdkTools: () => ({ echo_tool: sleepTool }),
    } as unknown as AgentRuntime;
    const agent = createReactAgent({
      name: "main",
      description: "main",
      runtime,
      toolNames: ["echo_tool"],
      purpose: "chat",
      buildSystemPrompt: async () => "sys",
      model,
    });
    const frames: SseFrame[] = [];
    for await (const frame of agent.run({ query: "问", scope: {}, history: [] })) {
      frames.push(frame);
    }

    const start = frames.find((f) => f.type === "step" && f.step.status === "start");
    expect(start).toBeDefined();
    if (start?.type === "step" && start.step.status === "start") {
      expect(start.step.args).toBeDefined();
      expect(start.step.args!.length).toBeLessThanOrEqual(121); // truncated + ellipsis
      expect(start.step.args).toContain('"query"');
    }
    const done = frames.find((f) => f.type === "step" && f.step.status === "done");
    expect(done).toBeDefined();
    if (done?.type === "step" && done.step.status === "done") {
      expect(done.step.durationMs).toBeGreaterThanOrEqual(25);
    }
  });
});
