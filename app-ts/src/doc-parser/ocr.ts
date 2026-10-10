import { generateText } from "ai";
import { aiTelemetry } from "../llm/tracing.js";
import { config } from "../config/index.js";
import { createGatewayModel } from "../llm/provider.js";
import { isVisionBlocked, type ModelCapabilityRegistry } from "../llm/model-capabilities.js";

/**
 * OCR clients: image documents → text, via a vision model through the gateway
 * (OpenAI-compatible message with a base64 data-URL image part).
 * The engine is pluggable (OcrClient port): swap GatewayVisionOcr for Paddle/
 * DashScope-OCR adapters without touching the parser or routes.
 */

/** kind drives the HTTP mapping in the upload route: disabled/config/upstream */
export class OcrError extends Error {
  constructor(
    readonly kind: "disabled" | "config" | "upstream",
    message: string,
  ) {
    super(message);
    this.name = "OcrError";
  }
}

export interface OcrClient {
  readonly enabled: boolean;
  recognize(filename: string, buffer: Buffer, mime: string): Promise<string>;
}

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "bmp"]);

export function isImageDocument(filename: string): boolean {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

export function imageMimeFor(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}

/** OCR disabled: image documents are rejected with an explicit, actionable message. */
export class DisabledOcr implements OcrClient {
  readonly enabled = false;

  async recognize(): Promise<string> {
    throw new OcrError("disabled", "OCR 未启用（OCR__ENABLED=false），无法识别图片文档；请改传含文本层的 pdf/docx/txt/md/html");
  }
}

/**
 * Vision-model OCR through the gateway. The configured model is validated against
 * the capability registry at call time — a text-only model fails fast with a clear
 * config error instead of a confusing upstream 400.
 */
export class GatewayVisionOcr implements OcrClient {
  readonly enabled = true;

  constructor(
    private readonly model: string = config.ocr.model,
    private readonly capabilities?: ModelCapabilityRegistry,
    private readonly generate: (system: string, dataUrl: string) => Promise<string> = async (system, dataUrl) => {
      const result = await generateText({
        model: createGatewayModel("ocr", { model: config.ocr.model, apiKey: config.ocr.apiKey || undefined }),
        ...aiTelemetry("ocr.recognize"),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: system },
              { type: "image", image: dataUrl },
            ],
          },
        ],
        temperature: 0,
        abortSignal: AbortSignal.timeout(config.ocr.timeoutMs),
      });
      return result.text.trim();
    },
  ) {}

  async recognize(filename: string, buffer: Buffer, mime: string): Promise<string> {
    if (buffer.length > config.ocr.maxImageBytes) {
      throw new OcrError(
        "config",
        `图片超过 OCR 大小上限（${Math.floor(config.ocr.maxImageBytes / 1024 / 1024)}MB）：${filename}`,
      );
    }
    if (this.capabilities && isVisionBlocked(this.capabilities.get(this.model))) {
      throw new OcrError(
        "config",
        `OCR 模型 "${this.model}" 不支持视觉输入（capability=vision:false），请改配视觉模型或用 MODELS__OVERRIDES 声明其能力`,
      );
    }
    const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
    try {
      const text = (await this.generate(config.ocr.prompt, dataUrl)).trim();
      if (!text) {
        throw new OcrError("upstream", `OCR 模型未返回文字内容：${filename}`);
      }
      return text;
    } catch (err) {
      if (err instanceof OcrError) throw err;
      throw new OcrError("upstream", `OCR 调用失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
