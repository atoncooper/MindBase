import { generateText } from "ai";

import { createGatewayModel } from "../../llm/provider.js";
import { aiTelemetry } from "../../llm/tracing.js";

/**
 * Vision review port: "look at these rendered pages and tell me what is wrong".
 *
 * This is the second half of the visual fallback: when the chat model cannot take
 * an Office file directly, the agent renders pages and asks a VISION model to
 * critique them; the critique text goes back into the ReAct loop, which then
 * edits the spec and regenerates. Keeping the call behind a port means the tool
 * is testable with a fake and degradable when no vision model is configured.
 */

export interface VisionReviewImage {
  /** 1-based page number, used in the prompt so findings can cite pages. */
  page: number;
  data: Uint8Array;
}

export interface VisionReviewInput {
  /** Task-specific instruction prepended to the page list. */
  instructions: string;
  images: VisionReviewImage[];
}

export interface VisionReviewPort {
  readonly enabled: boolean;
  /** Model id used (for logs/guidance); empty when disabled. */
  readonly model: string;
  review(input: VisionReviewInput): Promise<string>;
}

export class VisionReviewError extends Error {
  constructor(
    readonly code: "disabled" | "upstream",
    message: string,
  ) {
    super(message);
    this.name = "VisionReviewError";
  }
}

export interface GatewayVisionReviewOptions {
  model: string;
  timeoutMs: number;
  /** Injected for tests; defaults to a real gateway call. */
  generate?: (instructions: string, images: Array<{ page: number; dataUrl: string }>) => Promise<string>;
}

/** Same single-credential path as OCR: images ride as base64 data URLs via the gateway. */
export class GatewayVisionReview implements VisionReviewPort {
  readonly enabled = true;
  readonly model: string;

  constructor(private readonly options: GatewayVisionReviewOptions) {
    this.model = options.model;
  }

  async review(input: VisionReviewInput): Promise<string> {
    if (input.images.length === 0) throw new VisionReviewError("upstream", "没有可审查的页面图片");
    const images = input.images.map((image) => ({
      page: image.page,
      dataUrl: "data:image/png;base64," + Buffer.from(image.data).toString("base64"),
    }));
    try {
      const text = await (this.options.generate ?? ((instructions, items) => this.callGateway(instructions, items)))(
        input.instructions,
        images,
      );
      const trimmed = text.trim();
      if (trimmed === "") throw new VisionReviewError("upstream", "视觉模型未返回审查意见");
      return trimmed;
    } catch (err) {
      if (err instanceof VisionReviewError) throw err;
      throw new VisionReviewError(
        "upstream",
        "视觉模型调用失败：" + (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  private async callGateway(
    instructions: string,
    images: Array<{ page: number; dataUrl: string }>,
  ): Promise<string> {
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image"; image: string }
    > = [{ type: "text", text: instructions }];
    for (const image of images) {
      content.push({ type: "text", text: "第 " + image.page + " 页：" });
      content.push({ type: "image", image: image.dataUrl });
    }
    const result = await generateText({
      model: createGatewayModel("office_review", { model: this.model }),
      ...aiTelemetry("office.visual_review"),
      messages: [{ role: "user", content }],
      temperature: 0,
      abortSignal: AbortSignal.timeout(this.options.timeoutMs),
    });
    return result.text;
  }
}

/** Vision review disabled (no model configured): the caller degrades to structure text. */
export class DisabledVisionReview implements VisionReviewPort {
  readonly enabled = false;
  readonly model = "";

  constructor(private readonly reason: string) {}

  async review(): Promise<string> {
    throw new VisionReviewError("disabled", this.reason);
  }
}
