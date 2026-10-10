import { describe, expect, it } from "vitest";
import { builtinCapabilitiesFor, ModelCapabilityRegistry } from "./model-capabilities.js";

// 网关自有模型（OpenRouter 没有条目）的内置能力提示：文本模型必须拦下图片，
// 而不是放行后让模型回「我无法看到图片」这种含糊结果。
describe("builtinCapabilitiesFor", () => {
  it("qwen 文本族 → vision:false（含 qwq）", () => {
    for (const m of ["qwen3-max", "qwen-max", "Qwen-Plus", "qwen-long", "qwq-32b"]) {
      expect(builtinCapabilitiesFor(m)).toEqual({ vision: false });
    }
  });

  it("qwen 视觉族不拦截（交给元数据/默认）", () => {
    for (const m of ["qwen-vl-max", "qwen2.5-vl-32b", "qwen-vl-ocr", "qwen-omni-turbo"]) {
      expect(builtinCapabilitiesFor(m)).toBeUndefined();
    }
  });

  it("deepseek 族 → vision:false", () => {
    expect(builtinCapabilitiesFor("deepseek-chat")).toEqual({ vision: false });
  });

  it("其他模型不管（glm/开源命名等）", () => {
    expect(builtinCapabilitiesFor("z-ai/glm-5.3-flash")).toBeUndefined();
    expect(builtinCapabilitiesFor("gpt-4o")).toBeUndefined();
  });
});

describe("ModelCapabilityRegistry.get precedence", () => {
  it("builtin 命中 → source=override，isVisionBlocked 生效", () => {
    const reg = new ModelCapabilityRegistry("http://localhost:1/v1", 1, 10, "{}");
    const cap = reg.get("qwen3-max");
    expect(cap.vision).toBe(false);
    expect(cap.source).toBe("override");
  });

  it("MODELS__OVERRIDES 优先于 builtin", () => {
    const reg = new ModelCapabilityRegistry(
      "http://localhost:1/v1",
      1,
      10,
      JSON.stringify({ "qwen3-max": { vision: true } }),
    );
    expect(reg.get("qwen3-max").vision).toBe(true);
  });
});
