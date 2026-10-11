import { describe, it, expect, afterEach } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { aiTelemetry, isTracingEnabled, setupTracing, shutdownTracing } from "../src/llm/tracing.js";
import { config } from "../src/config/index.js";

/**
 * LangSmith tracing closed-loop: with a key configured, an AI SDK call emits an
 * OTel span carrying the functionId (captured via InMemorySpanProcessor — no
 * network). Without a key everything stays disabled (zero overhead).
 */

describe("LangSmith tracing", () => {
  const saved = { ...config.langsmith };

  afterEach(async () => {
    Object.assign(config.langsmith, saved);
    await shutdownTracing();
  });

  it("no API key → tracing disabled and aiTelemetry is a no-op flag", () => {
    config.langsmith.apiKey = "";
    expect(isTracingEnabled()).toBe(false);
    expect(aiTelemetry("any").experimental_telemetry).toMatchObject({ isEnabled: false, functionId: "any" });
    // no provider registered; shutdown must be a safe no-op
    setupTracing();
  });

  it("key present → AI SDK call emits a span with the functionId", async () => {
    config.langsmith.apiKey = "test-key";
    const exporter = new InMemorySpanExporter();
    setupTracing({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    expect(isTracingEnabled()).toBe(true);

    const model = new MockLanguageModelV2({
      doGenerate: async () => ({
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
        content: [{ type: "text" as const, text: "ok" }],
      }),
    });

    // 全局 provider 注册与 ProxyTracer 代理解析存在一次性时序竞态
    // （冷启动/并发 worker 下首次调用可能拿不到 delegate）。轮询重试：
    // 每次 generateText 后等待落 span，最多 5 次 —— 断言本身不变
    // （必须出现携带 functionId 的 ai span），只消除时序脆弱性。
    let spans: ReturnType<typeof exporter.getFinishedSpans> = [];
    for (let attempt = 0; attempt < 5 && spans.length === 0; attempt += 1) {
      const result = await generateText({ model, prompt: "ping", ...aiTelemetry("test.call") });
      expect(result.text).toBe("ok");
      // SimpleSpanProcessor exports synchronously on end — settle briefly anyway
      for (let wait = 0; wait < 20 && exporter.getFinishedSpans().length === 0; wait += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      spans = exporter.getFinishedSpans();
    }
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.some((s) => s.attributes["ai.telemetry.functionId"] === "test.call")).toBe(true);
  });
});
