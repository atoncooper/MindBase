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
    const result = await generateText({ model, prompt: "ping", ...aiTelemetry("test.call") });
    expect(result.text).toBe("ok");

    // SimpleSpanProcessor exports asynchronously — settle, then read BEFORE
    // shutdown (shutdown stops the in-memory exporter and drops late exports)
    await new Promise((resolve) => setTimeout(resolve, 50));
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.some((s) => s.attributes["ai.telemetry.functionId"] === "test.call")).toBe(true);
  });
});
