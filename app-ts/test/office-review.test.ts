import { describe, expect, it } from "vitest";

import type { SessionDocumentMeta, SessionDocumentRepository } from "../src/repository/session-docs.js";
import { OfficeDocumentService } from "../src/services/office-review.js";
import { buildDocxFromBlocks } from "../src/services/office/docx.js";
import { buildPptx } from "../src/services/office/pptx.js";
import { buildXlsx } from "../src/services/office/xlsx.js";
import type { RenderedPage } from "../src/services/office-render/renderer.js";
import { OfficeRenderError, type OfficeRenderPort } from "../src/services/office-render/renderer.js";
import type { VisionReviewInput, VisionReviewPort } from "../src/services/office-render/vision.js";

/**
 * Office reading pipeline: structure inspection over REAL generated packages
 * (docx/xlsx/pptx built by our own builders — no binary fixtures) plus the
 * visual-review orchestration driven by fake renderer/vision ports so every
 * degradation path is asserted without LibreOffice.
 */

class FakeVision implements VisionReviewPort {
  readonly enabled = true;
  readonly model = "fake-vision";
  readonly calls: VisionReviewInput[] = [];

  async review(input: VisionReviewInput): Promise<string> {
    this.calls.push(input);
    return "第 2 页：表格右列文字被裁切，建议缩小字号。\n第 1 页：标题与正文间距偏小。";
  }
}

class DisabledVision implements VisionReviewPort {
  readonly enabled = false;
  readonly model = "";
  async review(): Promise<string> {
    throw new Error("disabled");
  }
}

class FakeRenderer implements OfficeRenderPort {
  readonly available = true;
  readonly calls: Array<{ fileName: string; pages?: number[] }> = [];

  constructor(
    private readonly pageCount = 3,
    private readonly failure?: OfficeRenderError,
  ) {}

  async render(input: { fileName: string; pages?: number[] }): Promise<RenderedPage[]> {
    this.calls.push({ fileName: input.fileName, ...(input.pages ? { pages: input.pages } : {}) });
    if (this.failure) throw this.failure;
    return Array.from({ length: this.pageCount }, (_, index) => ({
      page: index + 1,
      png: new Uint8Array(Buffer.from("page-" + (index + 1))),
    }));
  }
}

class MissingRenderer implements OfficeRenderPort {
  readonly available = false;
  readonly unavailableReason = "未找到 LibreOffice（soffice），无法把 Office 渲染成图片";
  async render(): Promise<RenderedPage[]> {
    throw new OfficeRenderError("unavailable", this.unavailableReason);
  }
}

function serviceWith(deps: {
  bytes: Uint8Array;
  mime?: string;
  renderer?: OfficeRenderPort;
  vision?: VisionReviewPort;
  sessionDocument?: string;
  chatSessionId?: string;
}) {
  const meta: SessionDocumentMeta = {
    id: "doc-1",
    sessionId: "s-1",
    filename: deps.sessionDocument ?? "upload.pptx",
    sizeBytes: deps.bytes.byteLength,
    chunkCount: 1,
    createdAt: 1,
    key: "chat-files/1",
    ...(deps.mime ? { contentType: deps.mime } : {}),
  };
  const sessionDocs: SessionDocumentRepository = {
    async list() {
      return [meta];
    },
    async save() {
      return meta;
    },
    async search() {
      return [];
    },
    async delete() {
      return true;
    },
    async deleteBySession() {
      return 0;
    },
  };
  return new OfficeDocumentService({
    sessionDocs,
    sessionFiles: { async getBytes() { return deps.bytes; } },
    renderer: deps.renderer ?? new FakeRenderer(),
    vision: deps.vision ?? new FakeVision(),
    limits: {
      maxSourceBytes: 5 * 1024 * 1024,
      defaultPages: 6,
      maxPages: 16,
      maxImages: 2,
      renderTimeoutMs: 10_000,
      dpi: 96,
      visionTimeoutMs: 10_000,
    },
  });
}

const input = (sessionDocument: string) => ({
  uid: "7",
  ...(sessionDocument !== "" ? { chatSessionId: "s-1", sessionDocument } : { chatSessionId: "s-1" }),
});

describe("office_inspect", () => {
  it("renders a Word structure summary", async () => {
    const bytes = await buildDocxFromBlocks({
      title: "季度复盘",
      blocks: [
        { type: "heading", text: "一、结论", level: 1 },
        { type: "paragraph", text: "收入增长 18%。" },
        { type: "table", headers: ["指标", "数值"], rows: [["收入", "1200"]] },
      ],
    });
    const service = serviceWith({ bytes, sessionDocument: "review.docx" });
    const text = await service.inspect(input("review.docx"));
    expect(text).toContain("季度复盘");
    expect(text).toContain("一、结论");
  });

  it("renders an Excel structure summary with formulas", async () => {
    const bytes = await buildXlsx({
      title: "经营数据",
      sheets: [{ name: "经营数据", headers: ["项目", "Q3"], rows: [["收入", 1200], ["利润", "=B2-100"]] }],
    });
    const service = serviceWith({ bytes, sessionDocument: "data.xlsx" });
    const text = await service.inspect(input("data.xlsx"));
    expect(text).toContain("经营数据");
    expect(text).toContain("项目");
  });

  it("renders a PPT structure summary with per-slide titles", async () => {
    const bytes = await buildPptx({
      title: "汇报",
      slides: [
        { title: "年度汇报", subtitle: "2026" },
        { title: "关键进展", bullets: ["上线三个能力"] },
      ],
    });
    const service = serviceWith({ bytes, sessionDocument: "deck.pptx" });
    const text = await service.inspect(input("deck.pptx"));
    expect(text).toContain("年度汇报");
    expect(text).toContain("关键进展");
  });

  it("guides the model when the session has no such document", async () => {
    const bytes = await buildPptx({ title: "t", slides: [{ title: "s" }] });
    const service = serviceWith({ bytes, sessionDocument: "deck.pptx" });
    const text = await service.inspect(input("other.pptx"));
    expect(text).toContain("没有名为");
  });
});

describe("office_visual_check", () => {
  it("samples pages and returns the vision findings", async () => {
    const bytes = await buildPptx({
      title: "汇报",
      slides: [{ title: "封面" }, { title: "数据", table: { headers: ["a"], rows: [["1"]] } }, { title: "结论" }],
    });
    const renderer = new FakeRenderer(3);
    const vision = new FakeVision();
    const service = serviceWith({ bytes, renderer, vision, sessionDocument: "deck.pptx" });
    const text = await service.visualCheck(input("deck.pptx"), { maxPages: 3 });
    expect(text).toContain("【视觉复核】");
    expect(text).toContain("表格右列文字被裁切");
    expect(text).toContain("已渲染 3 页");
    expect(renderer.calls[0].fileName).toBe("deck.pptx");
    // maxImages = 2 -> only two page images are sent to the vision model
    expect(vision.calls[0].images).toHaveLength(2);
    expect(vision.calls[0].instructions).toContain("版式审查员");
  });

  it("explains the degradation when rendering is unavailable", async () => {
    const bytes = await buildPptx({ title: "t", slides: [{ title: "s" }] });
    const service = serviceWith({ bytes, renderer: new MissingRenderer(), sessionDocument: "deck.pptx" });
    const text = await service.visualCheck(input("deck.pptx"));
    expect(text).toContain("视觉复核暂不可用");
    expect(text).toContain("office_inspect");
  });

  it("reports rendered pages when no vision model is configured", async () => {
    const bytes = await buildPptx({ title: "t", slides: [{ title: "s" }] });
    const service = serviceWith({ bytes, vision: new DisabledVision(), sessionDocument: "deck.pptx" });
    const text = await service.visualCheck(input("deck.pptx"));
    expect(text).toContain("未配置视觉模型");
  });

  it("maps render failures to guidance text", async () => {
    const bytes = await buildPptx({ title: "t", slides: [{ title: "s" }] });
    const service = serviceWith({
      bytes,
      renderer: new FakeRenderer(3, new OfficeRenderError("failed", "soffice 未生成输出")),
      sessionDocument: "deck.pptx",
    });
    const text = await service.visualCheck(input("deck.pptx"));
    expect(text).toContain("渲染失败");
    expect(text).toContain("office_inspect");
  });
});
