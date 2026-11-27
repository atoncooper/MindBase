import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { buildOfficeDocumentArtifact } from "../src/artifacts/office-document.js";
import { AppCloudError } from "../src/clients/app-cloud-client.js";
import { runWithRequestContext } from "../src/context/request-context.js";
import { parseDocxDocumentPreview } from "../src/doc-parser/docx-blocks.js";
import { DOCX_MIME } from "../src/doc-parser/docx.js";
import { OfficeDocumentService } from "../src/services/office-review.js";
import { buildDocxFromBlocks } from "../src/services/office/docx.js";
import { docxSpecToDocumentBlocks } from "../src/services/office/document-preview.js";
import { registerOfficeDocumentRoutes } from "../src/transport/http/routes/office-document.js";

/**
 * Word document preview: artifact contract, block-spec conversion, the OOXML
 * round-trip (generate -> parse -> blocks), the cloud service method and the
 * HTTP route status mapping. No LibreOffice / MinIO.
 */

const docxBytes = async () =>
  buildDocxFromBlocks({
    title: "2026 年第三季度经营分析报告",
    blocks: [
      { type: "paragraph", text: "本季度收入与利润同步改善。" },
      { type: "heading", text: "一、经营概况", level: 1 },
      { type: "paragraph", text: "营业收入 1,200 万元，同比增长 18%。" },
      { type: "bullets", items: ["新增企业客户 12 家", "交付周期缩短 7 天"] },
      { type: "table", caption: "表 1 核心指标", headers: ["指标", "Q3"], rows: [["收入", "1200"], ["成本", "800"]] },
      { type: "heading", text: "二、下一步计划", level: 1 },
      { type: "bullets", ordered: true, items: ["上线智能问答 2.0", "交付周期压到 10 天"] },
    ],
  });

describe("office-document artifact", () => {
  it("accepts a structured document and stamps the version", () => {
    const built = buildOfficeDocumentArtifact({
      name: "报告.docx",
      format: "docx",
      uploadUuid: "u-1",
      meta: { title: "季度报告" },
      blocks: [
        { type: "heading", level: 1, text: "一、概况" },
        { type: "paragraph", text: "正文。" },
        { type: "bullets", items: ["A", "B"], ordered: true },
        { type: "table", headers: ["指标", "数值"], rows: [["收入", "1"]] },
        { type: "quote", text: "口径说明" },
        { type: "pageBreak" },
      ],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const data = built.artifact.data as { version: number; blocks: unknown[]; uploadUuid?: string };
    expect(built.artifact.kind).toBe("office-document");
    expect(data.version).toBe(1);
    expect(data.blocks).toHaveLength(6);
    expect(data.uploadUuid).toBe("u-1");
  });

  it("rejects empty payloads, unknown blocks and non-docx formats", () => {
    expect(buildOfficeDocumentArtifact({ name: "", blocks: [{ type: "paragraph", text: "x" }] }).ok).toBe(false);
    expect(buildOfficeDocumentArtifact({ name: "a", format: "xlsx", blocks: [{ type: "paragraph", text: "x" }] }).ok).toBe(false);
    expect(buildOfficeDocumentArtifact({ name: "a", blocks: [{ type: "html", text: "x" }] }).ok).toBe(false);
    expect(buildOfficeDocumentArtifact({ name: "a", blocks: [] }).ok).toBe(false);
  });
});

describe("docxSpecToDocumentBlocks", () => {
  it("flattens inline emphasis and keeps block order", () => {
    const blocks = docxSpecToDocumentBlocks([
      { type: "heading", text: "一、**重点**", level: 2 },
      { type: "paragraph", text: "收入 *增长* 18%。" },
      { type: "bullets", items: ["`A`", "B"], ordered: true },
      { type: "table", headers: ["指标"], rows: [["收入"]] },
      { type: "quote", text: "备注" },
      { type: "pageBreak" },
    ]);
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "bullets", "table", "quote", "pageBreak"]);
    expect(blocks[0]).toMatchObject({ type: "heading", level: 2, text: "一、重点" });
    expect(blocks[1]).toMatchObject({ type: "paragraph", text: "收入 增长 18%。" });
    expect(blocks[2]).toMatchObject({ type: "bullets", ordered: true });
  });
});

describe("docx round-trip -> preview blocks", () => {
  it("maps a generated document back into headings, lists and tables", async () => {
    const result = await parseDocxDocumentPreview(await docxBytes());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { blocks, title } = result.preview;
    expect(title).toContain("经营分析报告");
    const headings = blocks.filter((block) => block.type === "heading");
    expect(headings.length).toBe(2);
    const lists = blocks.filter((block) => block.type === "bullets") as Array<{ items: string[]; ordered?: boolean }>;
    expect(lists).toHaveLength(2);
    expect(lists[1].ordered).toBe(true);
    const tables = blocks.filter((block) => block.type === "table") as Array<{ headers?: string[]; rows: string[][] }>;
    expect(tables).toHaveLength(1);
    expect(tables[0].headers).toEqual(["指标", "Q3"]);
    expect(tables[0].rows[0]).toEqual(["收入", "1200"]);
  });
});

class FakeCloud {
  readonly configured = true;
  constructor(private readonly value: { data: Uint8Array; contentType: string } | "missing") {}
  async downloadFile() {
    if (this.value === "missing") throw new AppCloudError("云盘文件不存在", 404);
    return this.value;
  }
}

const inertRenderer = { available: false as const, async render() { throw new Error("unused"); } };
const inertVision = { enabled: false as const, model: "", async review() { return ""; } };

function serviceWith(cloud: unknown) {
  return new OfficeDocumentService({
    cloud: cloud as never,
    renderer: inertRenderer as never,
    vision: inertVision as never,
    limits: {
      maxSourceBytes: 20 * 1024 * 1024,
      defaultPages: 6,
      maxPages: 8,
      maxImages: 4,
      renderTimeoutMs: 10_000,
      dpi: 96,
      visionTimeoutMs: 10_000,
    },
  });
}

describe("OfficeDocumentService.documentPreview", () => {
  it("returns preview blocks for a stored docx", async () => {
    const bytes = await docxBytes();
    const service = serviceWith(new FakeCloud({ data: bytes, contentType: DOCX_MIME }));
    const result = await service.documentPreview("7", "12345678-1234-1234-1234-123456789abc", { name: "季度报告.docx" });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.data?.name).toBe("季度报告.docx");
    expect(result.data?.uploadUuid).toBe("12345678-1234-1234-1234-123456789abc");
    expect(result.data?.blocks.length).toBeGreaterThan(2);
  });

  it("degrades for non-docx and reports missing files", async () => {
    const pptx = new Uint8Array([1, 2, 3]);
    const wrongType = serviceWith(new FakeCloud({ data: pptx, contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
    const degraded = await wrongType.documentPreview("7", "12345678-1234-1234-1234-123456789abc");
    expect(degraded.available).toBe(false);

    const missing = serviceWith(new FakeCloud("missing"));
    const notFound = await missing.documentPreview("7", "12345678-1234-1234-1234-123456789abc");
    expect(notFound).toMatchObject({ available: false, status: 404 });
  });
});

describe("GET /chat/office/document", () => {
  const uuid = "12345678-1234-1234-1234-123456789abc";

  async function buildApp(documents: unknown, uid?: string) {
    const app = Fastify();
    if (uid !== undefined) {
      app.addHook("preHandler", (_req, _reply, done) => {
        runWithRequestContext({ uid, requestId: "test", startedAt: Date.now() }, done);
      });
    }
    registerOfficeDocumentRoutes(app, { documents: documents as never });
    await app.ready();
    return app;
  }

  it("returns the document payload and maps auth/validation errors", async () => {
    const documents = {
      async documentPreview() {
        return { available: true as const, data: { version: 1, format: "docx", name: "a.docx", blocks: [{ type: "paragraph", text: "x" }] } };
      },
    };
    const app = await buildApp(documents, "7");
    try {
      const ok = await app.inject({ method: "GET", url: "/chat/office/document?upload_uuid=" + uuid + "&name=a.docx" });
      expect(ok.statusCode).toBe(200);
      const body = ok.json() as { available: boolean };
      expect(body.available).toBe(true);
      const badUuid = await app.inject({ method: "GET", url: "/chat/office/document?upload_uuid=short" });
      expect(badUuid.statusCode).toBe(400);
    } finally {
      await app.close();
    }

    const anonymous = await buildApp(documents);
    try {
      const res = await anonymous.inject({ method: "GET", url: "/chat/office/document?upload_uuid=" + uuid });
      expect(res.statusCode).toBe(401);
    } finally {
      await anonymous.close();
    }
  });

  it("passes through 404 and the not-wired 503", async () => {
    const documents = {
      async documentPreview() {
        return { available: false as const, detail: "云盘文件不存在或无权访问", status: 404 };
      },
    };
    const app = await buildApp(documents, "7");
    try {
      const res = await app.inject({ method: "GET", url: "/chat/office/document?upload_uuid=" + uuid });
      expect(res.statusCode).toBe(404);
      const body = res.json() as { available: boolean; detail: string };
      expect(body.available).toBe(false);
    } finally {
      await app.close();
    }

    const unwired = await buildApp(undefined, "7");
    try {
      const res = await unwired.inject({ method: "GET", url: "/chat/office/document?upload_uuid=" + uuid });
      expect(res.statusCode).toBe(503);
    } finally {
      await unwired.close();
    }
  });
});
