import { describe, it, expect } from "vitest";
import { z } from "zod";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { createReactAgent } from "../src/agent/react.js";
import type { AgentRuntime } from "../src/tools/runtime.js";
import type { SseFrame } from "../src/transport/sse.js";

/**
 * delegate frames: when the main agent's ReAct loop calls delegate_to_agent,
 * the stream brackets the sub-agent execution with
 * {type:"delegate", agent, status, active, index} so the frontend can show how
 * many sub-agents are running. Closed-loop via a mock model emitting the
 * tool-call part (provider-level `input` is a JSON STRING) and a fake runtime
 * providing the tool (built with ai's tool(), exactly what buildSdkTools produces).
 */

const delegateSdkTool = tool({
  description: "delegate",
  inputSchema: z.object({ agent: z.string(), message: z.string() }),
  execute: async () => "子任务结果",
});

const runtime = {
  buildSdkTools: () => ({
    delegate_to_agent: delegateSdkTool,
  }),
} as unknown as AgentRuntime;

const metadata = { id: "r1", modelId: "mock", timestamp: new Date() };

/** fresh mock per test: two steps — step 1 delegates (tool-call), step 2 answers with text */
const makeModel = () =>
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
                { type: "tool-call", toolCallId: "c1", toolName: "delegate_to_agent", input: JSON.stringify({ agent: "note", message: "整理对话" }) },
                { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
              ]
            : [
                { type: "stream-start", warnings: [] },
                { type: "response-metadata", ...metadata },
                { type: "text-start", id: "t0" },
                { type: "text-delta", id: "t0", delta: "整理好了" },
                { type: "text-end", id: "t0" },
                { type: "finish", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } },
              ];
        return { stream: simulateReadableStream({ initialDelayInMs: 10, chunks }) };
      };
    })(),
  });

async function collect(): Promise<SseFrame[]> {
  const agent = createReactAgent({
    name: "main",
    description: "main",
    runtime,
    toolNames: ["delegate_to_agent"],
    purpose: "chat",
    buildSystemPrompt: async () => "sys",
    model: makeModel(), // inject the mock — production defaults to the gateway model
  });
  const frames: SseFrame[] = [];
  for await (const frame of agent.run({ query: "整理对话为笔记", scope: {}, history: [] })) {
    frames.push(frame);
  }
  return frames;
}

describe("delegate frames (sub-agent live status)", () => {
  it("brackets the sub-agent execution with start/done and a live count", async () => {
    const frames = await collect();

    const delegates = frames.filter((f) => f.type === "delegate");
    expect(delegates).toHaveLength(2);
    expect(delegates[0]).toMatchObject({ type: "delegate", agent: "note", status: "start", active: 1, index: 1 });
    expect(delegates[1]).toMatchObject({ type: "delegate", agent: "note", status: "done", active: 0, index: 1 });

    // start precedes the sub-agent result arriving; done precedes the answer text
    const startIndex = frames.findIndex((f) => f.type === "delegate" && f.status === "start");
    const doneIndex = frames.findIndex((f) => f.type === "delegate" && f.status === "done");
    const chunkIndex = frames.findIndex((f) => f.type === "chunk" && f.content === "整理好了");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeLessThan(doneIndex);
    expect(doneIndex).toBeLessThan(chunkIndex);
  });

  it("keeps the step timeline entries for the delegation as well", async () => {
    const frames = await collect();
    const steps = frames.filter((f) => f.type === "step");
    expect(steps.map((s) => s.step.action)).toEqual(["delegate_to_agent", "delegate_to_agent"]);
    expect(steps.map((s) => s.step.status)).toEqual(["start", "done"]);
  });
});
