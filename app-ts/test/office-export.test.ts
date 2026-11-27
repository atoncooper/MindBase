import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import { DOCX_MIME, parseDocxText } from "../src/doc-parser/docx.js";
import { buildDocxBuffer } from "../src/services/docx-writer.js";
import { buildDocxFromBlocks } from "../src/services/office/docx.js";
import { OfficeExportError } from "../src/services/office/errors.js";
import { OfficeExportService, OFFICE_MIME } from "../src/services/office/index.js";
import type { CloudFolderService } from "../src/services/cloud-folders.js";
import { buildPptx } from "../src/services/office/pptx.js";
import { buildXlsx } from "../src/services/office/xlsx.js";
import { XML_DECL } from "../src/services/office/ooxml.js";

/**
 * Office export: the three builders produce real OOXML packages (no fixtures —
 * the XML is inspected from the generated zip) and the service stores them
 * through a fake cloud port. Everything is offline; LibreOffice validation lives
 * outside the test suite (scripts/docs), since CI has no office runtime.
 */

/** Destination resolver stub: the folder pipeline itself is covered in office-folders.test.ts. */
function stubFolders(folderId = 0, path = "agent"): CloudFolderService {
  return { ensurePath: async () => ({ folderId, path }) } as unknown as CloudFolderService;
}

async function entries(buffer: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(buffer);
}

async function text(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (!file) throw new Error("missing part: " + path);
  return file.async("string");
}

describe("docx builder", () => {
  it("renders headings, emphasis, glyph lists, quote and tables", async () => {
    const buffer = await buildDocxFromBlocks({
      title: "季度复盘",
      blocks: [
        { type: "heading", text: "一、结论", level: 1 },
        { type: "paragraph", text: "本季度 **收入** 增长，见 *附录*。" },
        { type: "bullets", items: ["成本下降", "复购提升"] },
        { type: "bullets", items: ["第一步", "第二步"], ordered: true },
        { type: "quote", text: "数据口径以财务为准" },
        { type: "table", headers: ["指标", "数值"], rows: [["收入", "1200"], ["成本", "800"]], caption: "表 1 关键指标" },
        { type: "pageBreak" },
      ],
    });
    expect(buffer.byteLength).toBeGreaterThan(1000);

    const zip = await entries(buffer);
    const document = await text(zip, "word/document.xml");
    expect(document.startsWith(XML_DECL)).toBe(true);
    expect(document).toContain("季度复盘");
    expect(document).toContain('<w:pStyle w:val="Heading1"/>');
    expect(document).toContain("<w:b/>");
    expect(document).toContain("<w:i/>");
    // Standard package uses real Word numbering parts (bullet + decimal), not glyphs.
    expect(document).toContain('<w:numId w:val="1"/>');
    expect(document).toContain('<w:numId w:val="2"/>');
    expect(document).toContain("<w:tbl>");
    expect(document).toContain("表 1 关键指标");
    expect(document).toContain('<w:br w:type="page"/>');
    expect(document).toContain("w:color");
    // escaping: no raw ampersands
    expect(document).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);

    const styles = await text(zip, "word/styles.xml");
    expect(styles).toContain('w:styleId="Heading3"');
    expect(styles).toContain('w:styleId="Quote"');
  });

  it("round-trips through the docx text parser", async () => {
    const buffer = await buildDocxFromBlocks({
      title: "标题页",
      blocks: [
        { type: "heading", text: "第二章 方法", level: 2 },
        { type: "paragraph", text: "正文内容在这里。" },
      ],
    });
    const parsed = await parseDocxText(buffer);
    expect(parsed).toContain("第二章 方法");
    expect(parsed).toContain("正文内容在这里。");
  });

  it("keeps the template package styles and page setup", async () => {
    const template = await buildDocxBuffer({ title: "模板标题", sections: [{ title: "旧章节", content: "旧正文" }] });
    const templateZip = await entries(template);
    const templateStyles = await text(templateZip, "word/styles.xml");

    const buffer = await buildDocxFromBlocks({
      title: "新文档",
      template,
      blocks: [{ type: "paragraph", text: "替换后的正文" }],
    });
    const zip = await entries(buffer);
    const document = await text(zip, "word/document.xml");
    expect(document).toContain("替换后的正文");
    expect(document).not.toContain("旧正文");
    expect(document).toContain("<w:sectPr>");
    expect(await text(zip, "word/styles.xml")).toBe(templateStyles);
  });

  it("rejects an empty document", async () => {
    await expect(buildDocxFromBlocks({ blocks: [] })).rejects.toThrow(OfficeExportError);
  });
});

describe("xlsx builder", () => {
  it("renders headers, formulas, freeze pane, autofilter and a banner", async () => {
    const buffer = await buildXlsx({
      title: "数据表",
      sheets: [
        {
          name: "经营数据",
          title: "2026 Q3 经营数据",
          headers: ["项目", "金额"],
          rows: [
            ["收入", 1200],
            ["成本", 800],
            ["利润", "=B2-B3"],
          ],
          totalRow: true,
        },
      ],
    });
    const zip = await entries(buffer);
    const workbook = await text(zip, "xl/workbook.xml");
    expect(workbook).toContain('name="经营数据"');
    const sheet = await text(zip, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain("<f>B2-B3</f>");
    expect(sheet).toContain("inlineStr");
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<autoFilter ref="A2:B5"/>');
    expect(sheet).toContain("<mergeCells");
    expect(sheet).toContain('<c r="B4" s="3"><v>800</v></c>');
    const styles = await text(zip, "xl/styles.xml");
    expect(styles).toContain('formatCode="#,##0.00"');
    expect(await text(zip, "[Content_Types].xml")).toContain("spreadsheetml.sheet.main+xml");
  });

  it("sanitises sheet names and rejects duplicates safely", async () => {
    const buffer = await buildXlsx({
      title: "t",
      sheets: [
        { name: "a/b:c", rows: [[1]] },
        { name: "a/b:c", rows: [[2]] },
      ],
    });
    const workbook = await text(await entries(buffer), "xl/workbook.xml");
    const names = [...workbook.matchAll(/name="([^"]+)"/g)].map((match) => match[1]);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toContain("/");
    expect(names[0]).not.toBe(names[1]);
  });

  it("rejects empty workbooks and too many sheets", async () => {
    await expect(buildXlsx({ title: "t", sheets: [] })).rejects.toThrow(OfficeExportError);
    const sheets = Array.from({ length: 7 }, (_, index) => ({ name: "S" + index, rows: [[index]] }));
    await expect(buildXlsx({ title: "t", sheets })).rejects.toThrow(/工作表数量/);
  });
});

describe("pptx builder", () => {
  it("builds a cover, a section divider, a bullet page and a table page", async () => {
    const buffer = await buildPptx({
      title: "演示",
      footer: "MindBase",
      slides: [
        { title: "2026 年度汇报", subtitle: "产品与工程", kind: "title" },
        { title: "第一部分 概览", subtitle: "先看结论", kind: "section" },
        { title: "关键进展", bullets: ["**上线** 三个能力", "延迟下降 40%"] },
        {
          title: "数据",
          table: { headers: ["指标", "数值"], rows: [["DAU", "1.2 万"], ["留存", "38%"]] },
        },
      ],
    });
    const zip = await entries(buffer);
    const names = Object.keys(zip.files);
    for (const part of [
      "ppt/presentation.xml",
      "ppt/slideMasters/slideMaster1.xml",
      "ppt/slideLayouts/slideLayout1.xml",
      "ppt/theme/theme1.xml",
      "[Content_Types].xml",
    ]) {
      expect(names).toContain(part);
    }
    expect(names).toContain("ppt/slides/slide4.xml");

    const presentation = await text(zip, "ppt/presentation.xml");
    expect(presentation).toContain('<p:sldId id="256" r:id="rId2"/>');
    expect(presentation).toContain('cx="12192000"');

    const cover = await text(zip, "ppt/slides/slide1.xml");
    expect(cover).toContain("2026 年度汇报");
    expect(cover).toContain('val="1F2937"');

    const content = await text(zip, "ppt/slides/slide3.xml");
    expect(content).toContain("关键进展");
    expect(content).toContain('b="1"');
    expect(content).toContain('char="•"');

    const table = await text(zip, "ppt/slides/slide4.xml");
    expect(table).toContain("<a:tbl>");
    expect(table).toContain("留存");

    expect(await text(zip, "[Content_Types].xml")).toContain("presentationml.presentation.main+xml");
  });

  it("rejects empty decks", async () => {
    await expect(buildPptx({ title: "t", slides: [] })).rejects.toThrow(OfficeExportError);
  });
});

describe("OfficeExportService", () => {
  interface UploadCall {
    uid: string;
    folderId: number;
    name: string;
    bytes: number;
    mime: string;
  }

  function fakeCloud(uploads: UploadCall[], configured = true) {
    return {
      configured,
      async uploadFile(uid: string, folderId: number, name: string, data: Uint8Array, mimeType?: string) {
        uploads.push({ uid, folderId, name, bytes: data.byteLength, mime: mimeType ?? "" });
        return { upload_uuid: "uuid-" + uploads.length, name, size: data.byteLength };
      },
    };
  }

  it("names the file with title + timestamp and uploads it to the root folder", async () => {
    const uploads: UploadCall[] = [];
    const service = new OfficeExportService({
      cloud: fakeCloud(uploads),
      folders: stubFolders(),
      now: () => new Date("2026-11-25T12:34:00Z"),
      timeZone: "Asia/Shanghai",
    });
    const result = await service.export("42", {
      format: "xlsx",
      title: "2026 Q3 复盘",
      xlsx: { sheets: [{ name: "S", headers: ["a"], rows: [[1]] }] },
    });
    expect(result.fileName).toBe("2026 Q3 复盘_20261125-2034.xlsx");
    expect(result.uploadUuid).toBe("uuid-1");
    expect(result.folderId).toBe(0);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ uid: "42", folderId: 0, mime: OFFICE_MIME.xlsx });
    expect(uploads[0].bytes).toBeGreaterThan(500);
  });

  it("uses the configured folder id and docx mime", async () => {
    const uploads: UploadCall[] = [];
    const service = new OfficeExportService({ cloud: fakeCloud(uploads), folders: stubFolders(77, "agent/报告") });
    await service.export("7", {
      format: "docx",
      title: "报告",
      docx: { blocks: [{ type: "paragraph", text: "正文" }] },
    });
    expect(uploads[0].folderId).toBe(77);
    expect(uploads[0].mime).toBe(OFFICE_MIME.docx);
    expect(uploads[0].name).toMatch(/^报告_\d{8}-\d{4}\.docx$/);
  });

  it("fails with cloud_unavailable when app-cloud is not configured", async () => {
    const service = new OfficeExportService({ cloud: fakeCloud([], false) });
    await expect(
      service.export("1", { format: "pptx", title: "t", pptx: { slides: [{ title: "a" }] } }),
    ).rejects.toMatchObject({ code: "cloud_unavailable" });
  });

  it("rejects a package over the byte ceiling", async () => {
    const uploads: UploadCall[] = [];
    const service = new OfficeExportService({ cloud: fakeCloud(uploads), maxBytes: 100 });
    await expect(
      service.export("1", { format: "docx", title: "t", docx: { blocks: [{ type: "paragraph", text: "x".repeat(5000) }] } }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(uploads).toHaveLength(0);
  });

  it("requires the branch matching the format", async () => {
    const service = new OfficeExportService({ cloud: fakeCloud([]) });
    await expect(service.build({ format: "pptx", title: "t" })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("docx layout system", () => {
  it("renders cover, metrics, kv, callout and divider modules", async () => {
    const buffer = await buildDocxFromBlocks({
      title: "2026 年经营分析报告",
      theme: "report",
      blocks: [
        { type: "cover", title: "2026 年经营分析报告", subtitle: "管理层季度复盘", meta: ["财务部", "2026-11"] },
        { type: "heading", text: "一、关键指标", level: 1 },
        {
          type: "metrics",
          items: [
            { label: "营业收入", value: "1,200 万元", note: "同比 +18%" },
            { label: "毛利率", value: "33.3%", note: "环比 +2.1pp" },
            { label: "新增客户", value: "12 家" },
          ],
        },
        { type: "kv", columns: 2, items: [{ label: "报告周期", value: "2026 Q3" }, { label: "口径", value: "财务结算" }] },
        { type: "callout", title: "结论", text: "收入增长主要由企业客户贡献。", tone: "success" },
        { type: "divider" },
        { type: "table", caption: "表 1 收入结构", headers: ["业务", "Q3"], rows: [["企业", "820"]] },
      ],
    });
    const zip = await entries(buffer);
    const document = await text(zip, "word/document.xml");
    const styles = await text(zip, "word/styles.xml");
    expect(document).toContain("CoverTitle");
    expect(document).toContain('<w:br w:type="page"/>');
    expect(document).toContain("MetricValue");
    expect(document).toContain('w:fill="F7F8FA"');
    expect(document).toContain("KvLabel");
    expect(document).toContain('w:fill="ECFDF5"');
    expect(document).toContain('<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="FFFFFF"');
    expect(/w:pBdr><w:bottom w:val="single" w:sz="6"/.test(document)).toBe(true);
    expect(styles).toContain('w:sz w:val="40"'); // report title 20pt
    expect(styles).toContain("CoverTitle");
    expect(styles).toContain("MetricValue");
  });

  it("applies the resume theme (compact body, narrow margins, no first-line indent)", async () => {
    const buffer = await buildDocxFromBlocks({
      title: "张伟 · 数据分析师",
      theme: "resume",
      blocks: [
        { type: "line", text: "男　1998.06　138-0000-0000　zhangwei@example.com" },
        { type: "heading", text: "教育背景", level: 1 },
        { type: "line", text: "2022.09–2026.06　华东理工大学　信息管理　本科" },
      ],
    });
    const zip = await entries(buffer);
    const document = await text(zip, "word/document.xml");
    const styles = await text(zip, "word/styles.xml");
    expect(styles).toContain('w:sz w:val="21"'); // resume body 10.5pt
    expect(styles).not.toContain('<w:ind w:firstLineChars="200"/>');
    expect(document).toContain('w:left="1240"'); // narrow left margin
    expect(document).toContain('w:left="1240" w:header="720"');
  });

  it("honours the margins override", async () => {
    const buffer = await buildDocxFromBlocks({
      title: "通知",
      theme: "brief",
      margins: "wide",
      blocks: [{ type: "paragraph", text: "请于周五前提交材料。" }],
    });
    const document = await text(await entries(buffer), "word/document.xml");
    expect(document).toContain('w:left="2160"');
  });
});

describe("office_export tool", () => {
  it("returns only the file card for docx (preview lives in the cloud drive)", async () => {
    const { createOfficeExportTool } = await import("../src/tools/office/export.js");
    const { ResultCollector } = await import("../src/context/types.js");
    const service = new OfficeExportService({
      cloud: {
        configured: true,
        async uploadFile(_uid: string, _folderId: number, name: string, data: Uint8Array) {
          return { upload_uuid: "u-doc", name, size: data.byteLength };
        },
      },
      folders: stubFolders(),
      now: () => new Date("2026-11-25T12:00:00Z"),
      timeZone: "Asia/Shanghai",
    });
    const tool = createOfficeExportTool({ service });
    const output = await tool.execute(
      {
        format: "docx",
        title: "季度经营分析报告",
        docx: {
          blocks: [
            { type: "heading", text: "一、经营概况", level: 1 },
            { type: "paragraph", text: "营业收入 1,200 万元，同比增长 18%。" },
            { type: "metrics", items: [{ label: "营业收入", value: "1,200 万元", note: "同比 +18%" }] },
            { type: "table", caption: "表 1 核心指标", headers: ["指标", "Q3"], rows: [["收入", "1200"]] },
          ],
        },
      },
      { uid: "7", scope: {}, collector: new ResultCollector() },
    );
    expect(typeof output).not.toBe("string");
    const result = output as { content?: string; artifacts?: Array<{ kind: string }> };
    const kinds = (result.artifacts ?? []).map((artifact) => artifact.kind);
    expect(kinds).toEqual(["file"]);
    expect(result.content).toContain("云盘详情");
  });

  it("overwrites the existing file instead of creating a new one (revision mode)", async () => {
    let uploads = 0;
    let replaces = 0;
    const service = new OfficeExportService({
      cloud: {
        configured: true,
        async uploadFile() {
          uploads += 1;
          throw new Error("revision must not create a new file");
        },
        async replaceFile(_uid: string, uploadUuid: string) {
          replaces += 1;
          return { upload_uuid: uploadUuid, name: "季度报告_20261125-2000.docx", size: 1234 };
        },
      },
      folders: stubFolders(),
      now: () => new Date("2026-11-27T12:00:00Z"),
      timeZone: "Asia/Shanghai",
    });
    const result = await service.export("7", {
      format: "docx",
      title: "季度报告",
      revisionOf: "u-existing-0001",
      docx: { blocks: [{ type: "paragraph", text: "修改后的正文。" }] },
    });
    expect(replaces).toBe(1);
    expect(uploads).toBe(0);
    expect(result.uploadUuid).toBe("u-existing-0001");
    expect(result.folderLabel).toContain("版本覆盖");
  });

  it("does not consume export quota when revising and reports the same uploadUuid", async () => {
    const { createOfficeExportTool } = await import("../src/tools/office/export.js");
    const { ResultCollector } = await import("../src/context/types.js");
    const consumed: string[] = [];
    const service = new OfficeExportService({
      cloud: {
        configured: true,
        async uploadFile() {
          throw new Error("must not create");
        },
        async replaceFile(_uid: string, uploadUuid: string) {
          return { upload_uuid: uploadUuid, name: "季度报告.docx", size: 900 };
        },
      },
      folders: stubFolders(),
    });
    const tool = createOfficeExportTool({
      service,
      quota: { consumeKind: async (_uid: string, kind: string) => { consumed.push(kind); return true; } } as never,
    });
    const output = await tool.execute(
      {
        format: "docx",
        title: "季度报告",
        revisionOf: "u-existing-0001",
        docx: { blocks: [{ type: "paragraph", text: "修改后的正文。" }] },
      },
      { uid: "7", scope: {}, collector: new ResultCollector() },
    );
    expect(consumed).toHaveLength(0);
    expect(typeof output).toBe("object");
    const content = (output as { content?: string }).content ?? "";
    expect(content).toContain("已更新同一文件");
    expect(content).toContain("u-existing-0001");
  });

  it("returns a downloadable file artifact and calls the quota gate once", async () => {
    const { createOfficeExportTool } = await import("../src/tools/office/export.js");
    const { ResultCollector } = await import("../src/context/types.js");
    const uploads: Array<{ name: string }> = [];
    const consumed: string[] = [];
    const service = new OfficeExportService({
      cloud: {
        configured: true,
        async uploadFile(_uid: string, folderId: number, name: string, data: Uint8Array) {
          uploads.push({ name });
          return { upload_uuid: "u-1", name, size: data.byteLength };
        },
      },
      folders: stubFolders(),
    });
    const tool = createOfficeExportTool({
      service,
      quota: {
        async consumeKind(_uid: string, kind) {
          consumed.push(kind);
          return true;
        },
      },
    });
    const output = await tool.execute(
      {
        format: "pptx",
        title: "月度汇报",
        pptx: { slides: [{ title: "封面", subtitle: "2026-11" }, { title: "要点", bullets: ["A", "B"] }] },
      },
      { uid: "5", scope: {}, collector: new ResultCollector() },
    );
    expect(typeof output).not.toBe("string");
    const result = output as { content: string; artifacts?: Array<{ kind: string; data: Record<string, unknown> }> };
    expect(result.content).toContain("已生成PPT 演示文稿");
    expect(result.content).toContain("uploadUuid: u-1");
    expect(consumed).toEqual(["office_export"]);
    expect(result.artifacts?.[0]).toMatchObject({ kind: "file", data: { uploadUuid: "u-1", mime: OFFICE_MIME.pptx } });
    expect(uploads).toHaveLength(1);
  });

  it("refuses anonymous callers and quota exhaustion", async () => {
    const { createOfficeExportTool } = await import("../src/tools/office/export.js");
    const { ResultCollector } = await import("../src/context/types.js");
    const service = new OfficeExportService({ cloud: { configured: true, async uploadFile() { throw new Error("nope"); } }, folders: stubFolders() });
    const blocked = createOfficeExportTool({ service, quota: { async consumeKind() { return false; } } });
    const output = await blocked.execute(
      { format: "docx", title: "t", docx: { blocks: [{ type: "paragraph", text: "x" }] } },
      { uid: "9", scope: {}, collector: new ResultCollector() },
    );
    expect(output).toContain("额度");

    const anonymous = createOfficeExportTool({ service });
    const denied = await anonymous.execute(
      { format: "docx", title: "t", docx: { blocks: [{ type: "paragraph", text: "x" }] } },
      { scope: {}, collector: new ResultCollector() },
    );
    expect(denied).toContain("登录");
  });

  it("maps cloud outages to guidance text instead of throwing", async () => {
    const { createOfficeExportTool } = await import("../src/tools/office/export.js");
    const { ResultCollector } = await import("../src/context/types.js");
    const service = new OfficeExportService({ cloud: { configured: false, async uploadFile() { throw new Error("x"); } } });
    const tool = createOfficeExportTool({ service });
    const output = await tool.execute(
      { format: "xlsx", title: "t", xlsx: { sheets: [{ name: "S", rows: [[1]] }] } },
      { uid: "1", scope: {}, collector: new ResultCollector() },
    );
    expect(output).toContain("云盘");
  });
});
