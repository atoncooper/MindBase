import { describe, it, expect, vi, afterEach } from "vitest";
import { ModelCapabilityRegistry } from "../src/llm/model-capabilities.js";

// Minimal fixture mirroring the shape of OpenRouter GET /api/v1/models
const OPENROUTER_PAYLOAD = {
  data: [
    {
      id: "qwen/qwen3-max",
      context_length: 131072,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["tools", "tool_choice", "structured_outputs"],
    },
    {
      id: "qwen/qwen-vl-max",
      context_length: 32768,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      supported_parameters: ["tools"],
    },
    {
      id: "foo/text-only",
      architecture: { input_modalities: ["text"] },
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

async function withFetch(handler: () => Promise<Response>): Promise<ModelCapabilityRegistry> {
  vi.stubGlobal("fetch", vi.fn(handler));
  const r = new ModelCapabilityRegistry();
  await r.refresh();
  return r;
}

describe("ModelCapabilityRegistry", () => {
  it("derives vision/toolCalls from OpenRouter metadata", async () => {
    const r = await withFetch(async () => new Response(JSON.stringify(OPENROUTER_PAYLOAD), { status: 200 }));
    expect(r.known).toBe(3);

    const text = r.get("qwen/qwen3-max");
    expect(text).toMatchObject({ vision: false, toolCalls: true, source: "openrouter" });
    expect(text.contextLength).toBe(131072);

    const vision = r.get("qwen/qwen-vl-max");
    expect(vision).toMatchObject({ vision: true, toolCalls: true });

    // missing supported_parameters → toolCalls defaults to false
    expect(r.get("foo/text-only")).toMatchObject({ vision: false, toolCalls: false });
  });

  it("local overrides take precedence over OpenRouter metadata (Higress-rewritten names)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(OPENROUTER_PAYLOAD), { status: 200 })),
    );
    const r = new ModelCapabilityRegistry(
      "https://openrouter.ai/api/v1/models",
      24,
      10_000,
      JSON.stringify({ "my-gateway/vision-model": { vision: true } }),
    );
    await r.refresh();
    expect(r.get("my-gateway/vision-model")).toMatchObject({ vision: true, source: "override" });
    // unknown to both → safe text-only default
    expect(r.get("totally-unknown")).toMatchObject({ vision: false, source: "default" });
  });

  it("fetch failure degrades silently; previous data is kept", async () => {
    const ok = await withFetch(async () => new Response(JSON.stringify(OPENROUTER_PAYLOAD), { status: 200 }));
    expect(ok.known).toBe(3);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    expect(await ok.refresh()).toBe(false);
    expect(ok.known).toBe(3); // previous data retained
    expect(ok.get("qwen/qwen3-max").vision).toBe(false);

    const never = new ModelCapabilityRegistry();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    expect(await never.refresh()).toBe(false);
    expect(never.get("anything")).toMatchObject({ vision: false, source: "default" });
  });

  it("invalid overrides JSON is ignored, not thrown", () => {
    const r = new ModelCapabilityRegistry("u", 24, 1000, "{not json");
    expect(r.get("x").source).toBe("default");
  });

  it("stale flag flips after the TTL horizon", async () => {
    vi.useFakeTimers();
    const r = new ModelCapabilityRegistry("u", 24, 1000, "{}");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(OPENROUTER_PAYLOAD), { status: 200 })));
    expect(r.stale).toBe(true); // never refreshed
    await r.refresh();
    expect(r.stale).toBe(false);
    vi.advanceTimersByTime(25 * 3_600_000);
    expect(r.stale).toBe(true);
    vi.useRealTimers();
  });
});
