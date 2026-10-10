import { describe, it, expect } from "vitest";
import { parseDocument, UnsupportedDocumentError } from "../src/doc-parser/index.js";
import {
  isImageDocument,
  imageMimeFor,
  OcrError,
  GatewayVisionOcr,
  DisabledOcr,
  type OcrClient,
} from "../src/doc-parser/ocr.js";
import type { ModelCapabilityRegistry } from "../src/llm/model-capabilities.js";

const PNG = Buffer.from("fake-png-bytes");

function fakeCapabilities(vision: boolean, source: "override" | "openrouter" | "default" = "override"): ModelCapabilityRegistry {
  return { get: () => ({ vision, toolCalls: false, source }) } as unknown as ModelCapabilityRegistry;
}

describe("image document routing", () => {
  it("isImageDocument / imageMimeFor", () => {
    expect(isImageDocument("scan.PNG")).toBe(true);
    expect(isImageDocument("photo.jpeg")).toBe(true);
    expect(isImageDocument("doc.pdf")).toBe(false);
    expect(imageMimeFor("x.jpg")).toBe("image/jpeg");
    expect(imageMimeFor("x.png")).toBe("image/png");
  });

  it("image + disabled OCR → OcrError(kind=disabled) with actionable message", async () => {
    await expect(parseDocument("scan.png", PNG, new DisabledOcr())).rejects.toMatchObject({
      name: "OcrError",
      kind: "disabled",
    });
    await expect(parseDocument("scan.png", PNG)).rejects.toBeInstanceOf(OcrError);
  });

  it("image + enabled OCR → text comes from the OCR client", async () => {
    const ocr: OcrClient = {
      enabled: true,
      recognize: async (_f, _b, mime) => {
        expect(mime).toBe("image/png");
        return "图片里识别出的文字";
      },
    };
    const res = await parseDocument("scan.png", PNG, ocr);
    expect(res.text).toBe("图片里识别出的文字");
    expect(res.mime).toBe("image/png");
  });

  it("unsupported types still rejected", async () => {
    await expect(parseDocument("virus.exe", PNG)).rejects.toBeInstanceOf(UnsupportedDocumentError);
  });
});

describe("GatewayVisionOcr", () => {
  it("fails fast when the configured model is not vision-capable (positive knowledge)", async () => {
    const ocr = new GatewayVisionOcr("qwen3-max", fakeCapabilities(false, "override"), async () => "不应被调用");
    await expect(ocr.recognize("x.png", PNG, "image/png")).rejects.toMatchObject({
      kind: "config",
      message: expect.stringContaining("不支持视觉输入"),
    });
  });

  it("unknown model (registry default, text-only guess) passes through — Higress-only models like qwen-vl-ocr", async () => {
    const ocr = new GatewayVisionOcr("qwen-vl-ocr", fakeCapabilities(false, "default"), async (_s, dataUrl) => {
      expect(dataUrl).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
      return "识别结果";
    });
    await expect(ocr.recognize("x.png", PNG, "image/png")).resolves.toBe("识别结果");
  });

  it("passes a base64 data URL to the vision model and returns its text", async () => {
    let captured: string | undefined;
    const ocr = new GatewayVisionOcr("qwen/qwen-vl-ocr", fakeCapabilities(true), async (_system, dataUrl) => {
      captured = dataUrl;
      return "  识别结果  ";
    });
    const text = await ocr.recognize("x.png", PNG, "image/png");
    expect(text).toBe("识别结果");
    expect(captured).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  });

  it("wraps upstream failures as kind=upstream", async () => {
    const ocr = new GatewayVisionOcr("qwen/qwen-vl-ocr", fakeCapabilities(true), async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(ocr.recognize("x.png", PNG, "image/png")).rejects.toMatchObject({ kind: "upstream" });
  });

  it("empty OCR result is an upstream error, not silent success", async () => {
    const ocr = new GatewayVisionOcr("qwen/qwen-vl-ocr", fakeCapabilities(true), async () => "");
    await expect(ocr.recognize("x.png", PNG, "image/png")).rejects.toMatchObject({ kind: "upstream" });
  });
});
