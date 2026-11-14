import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { AppCloudError } from "../src/clients/app-cloud-client.js";
import { ResultCollector, type ToolRunContext } from "../src/context/types.js";
import { DOCX_MIME } from "../src/doc-parser/docx.js";
import {
  MAX_DOCX_BYTES,
  parseDocxDetail,
  renderDocxDetailText,
  type DocxDetail,
} from "../src/doc-parser/docx-detail.js";
import type { ChatImageStorage } from "../src/repository/chat-images.js";
import type { SessionDocumentMeta, SessionDocumentRepository } from "../src/repository/session-docs.js";
import { DocxInspectService, type DocxInspectServiceDeps } from "../src/services/docx-inspect.js";
import { createDocxInspectTool } from "../src/tools/docx/inspect.js";
import { TempWorkspaceManager } from "../src/context/temp-workspace.js";
import { runWithRequestContext } from "../src/context/request-context.js";

/**
 * docx detail inspection: the OOXML fixture is hand-built with JSZip (no real
 * Word file in the repo) and covers exactly the parts the second parsing level
 * claims to read — sectPr margins/columns/header refs, docDefaults + Heading/Normal
 * styles, paragraph runs with fonts/size/bold/italic/underline, a table with
 * gridSpan + vMerge + shading, header/footer parts and core properties.
 * The service paths (session upload / cloud drive) run over fakes; no network.
 */

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const HEADING_P =
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr>' +
  '<w:r><w:rPr><w:b/><w:rFonts w:ascii="Times New Roman" w:eastAsia="黑体"/><w:sz w:val="32"/></w:rPr>' +
  "<w:t>第一章 引言</w:t></w:r></w:p>";

const BODY_P =
  '<w:p><w:pPr><w:jc w:val="both"/><w:ind w:firstLine="420" w:left="0"/>' +
  '<w:spacing w:before="240" w:after="120" w:line="360" w:lineRule="auto"/>' +
  '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' +
  "<w:r><w:t>普通正文段落，</w:t></w:r>" +
  '<w:r><w:rPr><w:i/><w:color w:val="FF0000"/><w:sz w:val="24"/></w:rPr><w:t>强调内容</w:t></w:r>' +
  '<w:r><w:rPr><w:u w:val="single"/><w:vertAlign w:val="superscript"/></w:rPr><w:t>脚注</w:t></w:r></w:p>';

const EMPTY_P = '<w:p><w:r><w:t></w:t></w:r></w:p>';

const TABLE =
  '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr>' +
  '<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' +
  "<w:tr><w:trPr><w:tblHeader/></w:trPr>" +
  '<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>方法</w:t></w:r></w:p></w:tc>' +
  '<w:tc><w:tcPr><w:shd w:fill="D9D9D9"/></w:tcPr><w:p><w:r><w:t>召回</w:t></w:r></w:p></w:tc></w:tr>' +
  "<w:tr>" +
  '<w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>' +
  "<w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>" +
  "<w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc></w:tr>" +
  "<w:tr>" +
  "<w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc>" +
  "<w:tc><w:p><w:r><w:t>D</w:t></w:r></w:p></w:tc>" +
  "<w:tc><w:p><w:r><w:t>E</w:t></w:r></w:p></w:tc></w:tr></w:tbl>";

const SECT_PR =
  "<w:sectPr>" +
  '<w:headerReference w:type="default" r:id="rIdH1"/>' +
  '<w:footerReference w:type="default" r:id="rIdF1"/>' +
  "<w:titlePg/>" +
  '<w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/>' +
  '<w:cols w:num="2" w:space="425"/>' +
  "</w:sectPr>";

const DOCUMENT_XML =
  XML_DECL +
  '<w:document xmlns:w="' + W_NS + '" xmlns:r="' + R_NS + '"><w:body>' +
  HEADING_P +
  BODY_P +
  EMPTY_P +
  TABLE +
  SECT_PR +
  "</w:body></w:document>";

const STYLES_XML =
  XML_DECL +
  '<w:styles xmlns:w="' + W_NS + '">' +
  "<w:docDefaults><w:rPrDefault><w:rPr>" +
  '<w:rFonts w:ascii="Calibri" w:eastAsia="宋体" w:hAnsi="Calibri"/>' +
  '<w:sz w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/>' +
  "</w:rPr></w:rPrDefault></w:docDefaults>" +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>' +
  '<w:rPr><w:sz w:val="24"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>' +
  '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr>' +
  '<w:rPr><w:b/><w:sz w:val="32"/><w:rFonts w:eastAsia="黑体"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/>' +
  '<w:rPr><w:b/><w:sz w:val="44"/></w:rPr></w:style>' +
  "</w:styles>";

const DOC_RELS =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '<Relationship Id="rIdH1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' +
  '<Relationship Id="rIdF1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' +
  "</Relationships>";

const HEADER_XML =
  XML_DECL +
  '<w:hdr xmlns:w="' + W_NS + '"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>' +
  "<w:r><w:t>某某大学毕业论文 &amp; 附录</w:t></w:r></w:p></w:hdr>";

const FOOTER_XML =
  XML_DECL + '<w:ftr xmlns:w="' + W_NS + '"><w:p><w:r><w:t>第 1 页</w:t></w:r></w:p></w:ftr>';

const CORE_XML =
  XML_DECL +
  '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
  ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
  ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
  "<dc:title>2027 届毕业论文（设计）任务书</dc:title>" +
  "<dc:creator>张三</dc:creator>" +
  "<cp:lastModifiedBy>李四</cp:lastModifiedBy>" +
  "<dc:subject>任务书</dc:subject>" +
  "<cp:keywords>论文;任务书</cp:keywords>" +
  '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-11-13T08:00:00Z</dcterms:modified>' +
  "</cp:coreProperties>";

/** Builds the minimal docx fixture described above. */
async function makeDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("word/document.xml", DOCUMENT_XML);
  zip.file("word/styles.xml", STYLES_XML);
  zip.file("word/header1.xml", HEADER_XML);
  zip.file("word/footer1.xml", FOOTER_XML);
  zip.file("word/_rels/document.xml.rels", DOC_RELS);
  zip.file("docProps/core.xml", CORE_XML);
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return new Uint8Array(buffer);
}

const DOCX_PROMISE = makeDocx();

const SESSION_DOC: SessionDocumentMeta = {
  id: "doc-1",
  sessionId: "s1",
  filename: "任务书.docx",
  sizeBytes: 4096,
  chunkCount: 3,
  createdAt: 1,
  key: "chat-files/doc-1.docx",
  contentType: DOCX_MIME,
};

function fakeSessionDocs(docs: SessionDocumentMeta[]): SessionDocumentRepository {
  return {
    async save() {
      throw new Error("not used in this test");
    },
    async list() {
      return docs;
    },
    async search() {
      return [];
    },
    async delete() {
      return false;
    },
    async deleteBySession() {
      return 0;
    },
  };
}

function fakeFiles(bytes: Uint8Array | undefined): Pick<ChatImageStorage, "getBytes"> {
  return {
    async getBytes() {
      return bytes;
    },
  };
}

interface FakeCloudOptions {
  configured?: boolean;
  data?: Uint8Array;
  contentType?: string;
  error?: AppCloudError;
}

function fakeCloud(options: FakeCloudOptions = {}): Pick<DocxInspectServiceDeps, "cloud"> {
  return {
    cloud: {
      get configured() {
        return options.configured ?? true;
      },
      async downloadFile() {
        if (options.error) throw options.error;
        return { contentType: options.contentType ?? DOCX_MIME, data: options.data ?? new Uint8Array() };
      },
    },
  };
}

function serviceWith(deps: Partial<DocxInspectServiceDeps>): DocxInspectService {
  return new DocxInspectService(deps);
}

function makeCtx(): ToolRunContext {
  return { uid: "1", chatSessionId: "s1", scope: {}, collector: new ResultCollector() };
}

function styleOf(detail: DocxDetail, styleId: string) {
  return detail.styles.find((style) => style.styleId === styleId);
}

describe("parseDocxDetail", () => {
  it("reads page setup, sections and header/footer references", async () => {
    const parsed = await parseDocxDetail(await DOCX_PROMISE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { page } = parsed.detail;
    expect(page.widthTwips).toBe(11906);
    expect(page.heightTwips).toBe(16838);
    expect(page.paper).toBe("A4");
    expect(page.orientation).toBe("portrait");
    expect(page.margins?.topMm).toBe(25.4);
    expect(page.margins?.leftMm).toBeCloseTo(31.8, 1);
    expect(page.margins?.headerMm).toBeCloseTo(15.0, 1);
    expect(page.columns?.count).toBe(2);
    expect(page.titlePage).toBe(true);
    expect(page.sectionCount).toBe(1);
    expect(page.headerRefs).toEqual([{ type: "default", target: "word/header1.xml" }]);
    expect(page.footerRefs).toEqual([{ type: "default", target: "word/footer1.xml" }]);
  });

  it("reads docDefaults fonts and paragraph styles (Normal/Heading1/Title)", async () => {
    const parsed = await parseDocxDetail(await DOCX_PROMISE);
    if (!parsed.ok) throw new Error(parsed.error);
    const detail = parsed.detail;
    expect(detail.fonts.ascii).toBe("Calibri");
    expect(detail.fonts.eastAsia).toBe("宋体");
    expect(detail.fonts.sizePt).toBe(12);
    expect(detail.fonts.lang).toBe("en-US");
    expect(detail.fonts.eastAsiaLang).toBe("zh-CN");
    expect(detail.styleCount).toBe(3);

    const heading = styleOf(detail, "Heading1");
    expect(heading?.builtin).toBe("Heading 1");
    expect(heading?.bold).toBe(true);
    expect(heading?.sizePt).toBe(16);
    expect(heading?.outlineLevel).toBe(0);
    expect(heading?.basedOn).toBe("Normal");
    expect(heading?.eastAsiaFont).toBe("黑体");
    expect(styleOf(detail, "Normal")?.builtin).toBe("Normal");
    expect(styleOf(detail, "Title")?.builtin).toBe("Title");
    expect(styleOf(detail, "Title")?.sizePt).toBe(22);
  });

  it("reads paragraph styles, alignment, indentation, numbering and run formatting", async () => {
    const parsed = await parseDocxDetail(await DOCX_PROMISE);
    if (!parsed.ok) throw new Error(parsed.error);
    const detail = parsed.detail;
    expect(detail.paragraphCount).toBe(2); // the empty paragraph is skipped
    expect(detail.paragraphs).toHaveLength(2);

    const [heading, body] = detail.paragraphs;
    expect(heading.styleId).toBe("Heading1");
    expect(heading.alignment).toBe("center");
    expect(heading.text).toBe("第一章 引言");
    expect(heading.runs[0].bold).toBe(true);
    expect(heading.runs[0].sizePt).toBe(16);
    expect(heading.runs[0].eastAsiaFont).toBe("黑体");
    expect(heading.runs[0].asciiFont).toBe("Times New Roman");

    expect(body.text).toContain("普通正文段落");
    expect(body.text).toContain("强调内容");
    expect(body.alignment).toBe("both");
    expect(body.indent?.firstLineTwips).toBe(420);
    expect(body.spacing?.lineTwips).toBe(360);
    expect(body.spacing?.lineRule).toBe("auto");
    expect(body.numbering).toEqual({ numId: "1", level: 0 });
    const italic = body.runs.find((run) => run.italic === true);
    expect(italic?.color).toBe("FF0000");
    expect(italic?.sizePt).toBe(12);
    const underlined = body.runs.find((run) => run.underline !== undefined);
    expect(underlined?.underline).toBe("single");
    expect(underlined?.verticalAlign).toBe("superscript");
  });

  it("reads table style, grid, gridSpan, vertical merge, shading and header row", async () => {
    const parsed = await parseDocxDetail(await DOCX_PROMISE);
    if (!parsed.ok) throw new Error(parsed.error);
    const detail = parsed.detail;
    expect(detail.tableCount).toBe(1);
    const table = detail.tables[0];
    expect(table.styleId).toBe("TableGrid");
    expect(table.gridColumns).toEqual([2000, 2000, 2000]);
    expect(table.rowCount).toBe(3);
    expect(table.columnCount).toBe(3);
    expect(table.width).toEqual({ percent: 100, type: "pct" });
    expect(table.rows[0].header).toBe(true);
    expect(table.rows[0].cells[0].gridSpan).toBe(2);
    expect(table.rows[0].cells[0].text).toBe("方法");
    expect(table.rows[0].cells[1].shading).toBe("D9D9D9");
    expect(table.rows[1].cells[0].verticalMerge).toBe("restart");
    expect(table.rows[2].cells[0].verticalMerge).toBe("continue");
    expect(table.rows[2].cells[0].text).toBe("A2");
  });

  it("reads header/footer parts, their section references, entities and metadata", async () => {
    const parsed = await parseDocxDetail(await DOCX_PROMISE);
    if (!parsed.ok) throw new Error(parsed.error);
    const detail = parsed.detail;
    const header = detail.headers.find((part) => part.kind === "header");
    expect(header?.part).toBe("word/header1.xml");
    expect(header?.referencedBy).toEqual(["第 1 节 default"]);
    expect(header?.paragraphs[0]).toContain("某某大学毕业论文 & 附录"); // &amp; decoded, never expanded
    const footer = detail.headers.find((part) => part.kind === "footer");
    expect(footer?.paragraphs).toEqual(["第 1 页"]);
    expect(detail.metadata?.title).toBe("2027 届毕业论文（设计）任务书");
    expect(detail.metadata?.creator).toBe("张三");
    expect(detail.metadata?.lastModifiedBy).toBe("李四");
    expect(detail.metadata?.keywords).toBe("论文;任务书");
    expect(detail.metadata?.modified).toContain("2026-11-13");
    expect(detail.stats.fontSizeSet).toEqual([12, 16, 22]);
  });

  it("honours maxParagraphs (0 = no paragraphs) and reports truncation", async () => {
    const parsed = await parseDocxDetail(await DOCX_PROMISE, { maxParagraphs: 0 });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.detail.paragraphs).toHaveLength(0);
    expect(parsed.detail.paragraphCount).toBe(2);
    expect(parsed.detail.paragraphsTruncated).toBe(true);
  });

  it("rejects empty, non-zip and over-sized buffers without throwing", async () => {
    const empty = await parseDocxDetail(new Uint8Array());
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("为空");

    const broken = await parseDocxDetail(new TextEncoder().encode("not a zip"));
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toContain("无法打开 Word 包");

    const tooBig = await parseDocxDetail(new Uint8Array(MAX_DOCX_BYTES + 1));
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error).toContain("过大");
  });

  it("rejects a zip that has no word/document.xml", async () => {
    const zip = new JSZip();
    zip.file("word/styles.xml", STYLES_XML);
    const buffer = new Uint8Array(await zip.generateAsync({ type: "nodebuffer" }));
    const parsed = await parseDocxDetail(buffer);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("word/document.xml");
  });
});

describe("renderDocxDetailText", () => {
  it("renders page margins, fonts, table merges and headers as Chinese text", async () => {
    const parsed = await parseDocxDetail(await DOCX_PROMISE);
    if (!parsed.ok) throw new Error(parsed.error);
    const text = renderDocxDetailText(parsed.detail, { name: "任务书.docx" });
    expect(text).toContain("Word 文档拆解：任务书.docx");
    expect(text).toContain("纸张：A4");
    expect(text).toContain("页边距（mm）");
    expect(text).toContain("宋体");
    expect(text).toContain("Heading 1");
    expect(text).toContain("第一章 引言");
    expect(text).toContain("表格");
    expect(text).toContain("跨 2 列");
    expect(text).toContain("纵向合并·起始");
    expect(text).toContain("某某大学毕业论文 & 附录");
    expect(text).toContain("任务书"); // metadata title
    expect(text).toContain("12pt");
    expect(text.length).toBeLessThanOrEqual(6000);
  });

  it("filters blocks with focus and clips to maxChars with an explicit hint", async () => {
    const parsed = await parseDocxDetail(await DOCX_PROMISE);
    if (!parsed.ok) throw new Error(parsed.error);
    const pageOnly = renderDocxDetailText(parsed.detail, { focus: ["page"] });
    expect(pageOnly).toContain("【页面与分节】");
    expect(pageOnly).not.toContain("【段落");
    expect(pageOnly).not.toContain("【表格");

    const tablesOnly = renderDocxDetailText(parsed.detail, { focus: ["tables"] });
    expect(tablesOnly).toContain("跨 2 列");
    expect(tablesOnly).not.toContain("【页面与分节】");

    const clipped = renderDocxDetailText(parsed.detail, { maxChars: 160 });
    expect(clipped.length).toBeLessThanOrEqual(200);
    expect(clipped).toContain("已截断");
  });
});

describe("DocxInspectService", () => {
  it("inspects a conversation upload resolved by filename", async () => {
    const docx = await DOCX_PROMISE;
    const service = serviceWith({
      sessionDocs: fakeSessionDocs([SESSION_DOC]),
      sessionFiles: fakeFiles(docx),
    });
    const text = await service.inspect({ chatSessionId: "s1", sessionDocument: "任务书.docx" });
    expect(text).toContain("Word 文档拆解：任务书.docx");
    expect(text).toContain("页边距");
    expect(text).toContain("宋体");
    expect(text).toContain("跨 2 列");
  });

  it("inspects a conversation upload resolved by document id", async () => {
    const docx = await DOCX_PROMISE;
    const service = serviceWith({
      sessionDocs: fakeSessionDocs([SESSION_DOC]),
      sessionFiles: fakeFiles(docx),
    });
    const text = await service.inspect({ chatSessionId: "s1", sessionDocument: "doc-1" });
    expect(text).toContain("任务书.docx");
  });

  it("inspects a project cloud-drive file over the app-cloud download", async () => {
    const docx = await DOCX_PROMISE;
    const service = serviceWith(fakeCloud({ data: docx }));
    const text = await service.inspect({ uid: "1", uploadUuid: "uuid-1" });
    expect(text).toContain("云盘文件 uuid-1");
    expect(text).toContain("页边距");
    expect(text).toContain("表格");
  });

  it("returns guidance when the source is missing or ambiguous", async () => {
    const service = serviceWith({});
    expect(await service.inspect({ uid: "1" })).toContain("请提供要解析的 Word 来源");
    expect(
      await service.inspect({ uid: "1", sessionDocument: "a.docx", uploadUuid: "uuid-1" }),
    ).toContain("请用 source 明确来源");
  });

  it("returns guidance for every session-side failure", async () => {
    // no chat session
    expect(
      await serviceWith({ sessionDocs: fakeSessionDocs([SESSION_DOC]), sessionFiles: fakeFiles(await DOCX_PROMISE) }).inspect({
        sessionDocument: "任务书.docx",
      }),
    ).toContain("没有会话 id");

    // attachment storage not wired
    expect(
      await serviceWith({ sessionDocs: fakeSessionDocs([SESSION_DOC]) }).inspect({
        chatSessionId: "s1",
        sessionDocument: "任务书.docx",
      }),
    ).toContain("附件存储不可用");

    // unknown document name
    expect(
      await serviceWith({ sessionDocs: fakeSessionDocs([SESSION_DOC]), sessionFiles: fakeFiles(await DOCX_PROMISE) }).inspect({
        chatSessionId: "s1",
        sessionDocument: "不存在.docx",
      }),
    ).toContain("没有名为");

    // not a docx
    const notesDoc: SessionDocumentMeta = { ...SESSION_DOC, id: "doc-2", filename: "笔记.txt", contentType: "text/plain" };
    expect(
      await serviceWith({ sessionDocs: fakeSessionDocs([notesDoc]), sessionFiles: fakeFiles(await DOCX_PROMISE) }).inspect({
        chatSessionId: "s1",
        sessionDocument: "笔记.txt",
      }),
    ).toContain("不是 .docx");

    // original binary not retained
    const legacyDoc: SessionDocumentMeta = { ...SESSION_DOC, key: undefined };
    expect(
      await serviceWith({ sessionDocs: fakeSessionDocs([legacyDoc]), sessionFiles: fakeFiles(undefined) }).inspect({
        chatSessionId: "s1",
        sessionDocument: "任务书.docx",
      }),
    ).toContain("原件没有留存");

    // object storage lost the bytes
    expect(
      await serviceWith({ sessionDocs: fakeSessionDocs([SESSION_DOC]), sessionFiles: fakeFiles(undefined) }).inspect({
        chatSessionId: "s1",
        sessionDocument: "任务书.docx",
      }),
    ).toContain("读取会话文档原件失败");
  });

  it("returns guidance for every cloud-side failure", async () => {
    // cloud not configured
    expect(
      await serviceWith(fakeCloud({ configured: false })).inspect({ uid: "1", uploadUuid: "uuid-1" }),
    ).toContain("云盘服务未启用");

    // missing uid
    expect(await serviceWith(fakeCloud({})).inspect({ uploadUuid: "uuid-1" })).toContain("没有用户身份");

    // 404 (missing or foreign file)
    expect(
      await serviceWith(fakeCloud({ error: new AppCloudError("cloud 404", 404) })).inspect({
        uid: "1",
        uploadUuid: "uuid-x",
      }),
    ).toContain("不存在或无权访问");

    // 503
    expect(
      await serviceWith(fakeCloud({ error: new AppCloudError("cloud 503", 503) })).inspect({
        uid: "1",
        uploadUuid: "uuid-x",
      }),
    ).toContain("云盘服务暂不可用");

    // non-docx declared mime
    expect(
      await serviceWith(fakeCloud({ data: new Uint8Array([1, 2, 3]), contentType: "image/png" })).inspect({
        uid: "1",
        uploadUuid: "uuid-x",
      }),
    ).toContain("不是 .docx");
  });

  it("rejects over-sized files and reports parse failures as guidance", async () => {
    const tooBig = new Uint8Array(MAX_DOCX_BYTES + 1);
    const service = serviceWith({
      sessionDocs: fakeSessionDocs([SESSION_DOC]),
      sessionFiles: fakeFiles(tooBig),
    });
    expect(await service.inspect({ chatSessionId: "s1", sessionDocument: "任务书.docx" })).toContain("过大");

    const brokenService = serviceWith(fakeCloud({ data: new TextEncoder().encode("not a zip") }));
    expect(await brokenService.inspect({ uid: "1", uploadUuid: "uuid-1" })).toContain("详细解析失败");
  });

  it("passes focus/maxParagraphs through to the summary", async () => {
    const docx = await DOCX_PROMISE;
    const service = serviceWith(fakeCloud({ data: docx }));
    const pageOnly = await service.inspect({ uid: "1", uploadUuid: "uuid-1" }, { focus: ["page"] });
    expect(pageOnly).toContain("页边距");
    expect(pageOnly).not.toContain("【段落");

    const noParagraphs = await service.inspect(
      { uid: "1", uploadUuid: "uuid-1" },
      { maxParagraphs: 0 },
    );
    expect(noParagraphs).toContain("没有可展示的正文段落");
    expect(noParagraphs).not.toContain("第一章 引言");
  });
});

describe("docx_inspect tool", () => {
  it("returns the detail summary for a conversation upload", async () => {
    const docx = await DOCX_PROMISE;
    const tool = createDocxInspectTool(
      new DocxInspectService({
        sessionDocs: fakeSessionDocs([SESSION_DOC]),
        sessionFiles: fakeFiles(docx),
      }),
    );
    const output = await tool.execute({ sessionDocument: "任务书.docx" }, makeCtx());
    expect(typeof output).toBe("string");
    expect(output).toContain("Word 文档拆解：任务书.docx");
    expect(output).toContain("页边距");
  });

  it("honours focus and maxParagraphs arguments", async () => {
    const tool = createDocxInspectTool(new DocxInspectService(fakeCloud({ data: await DOCX_PROMISE })));
    const pageOnly = await tool.execute({ uploadUuid: "uuid-1", focus: ["page"] }, makeCtx());
    expect(pageOnly).toContain("页边距");
    expect(pageOnly).not.toContain("【段落");
    const noParagraphs = await tool.execute({ uploadUuid: "uuid-1", maxParagraphs: 0 }, makeCtx());
    expect(noParagraphs).toContain("没有可展示的正文段落");
  });

  it("answers invalid arguments with guidance instead of throwing", async () => {
    const tool = createDocxInspectTool(new DocxInspectService({}));
    const output = await tool.execute({}, makeCtx());
    expect(typeof output).toBe("string");
    expect(output).toContain("请提供要解析的 Word 来源");
    const explicit = await tool.execute({ source: "session", sessionDocument: "a.docx" }, makeCtx());
    expect(explicit).toContain("附件存储不可用");
    expect(tool.name).toBe("docx_inspect");
  });
});

// ---------------------------------------------------------------------------
// Temp-file integration (docs/temp-files.md): download → local file → parse,
// deleted only when the whole turn is disposed by the program.
// ---------------------------------------------------------------------------

describe("DocxInspectService · local temp file path", () => {
  let baseDir = "";
  let manager: TempWorkspaceManager;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "mindbase-docx-temp-"));
    manager = new TempWorkspaceManager({ baseDir });
  });

  afterEach(async () => {
    await manager.close().catch(() => undefined);
    await fs.rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function listFiles(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await listFiles(full)));
      else out.push(full);
    }
    return out;
  }

  it("parses from a materialized file that survives until disposeRequest", async () => {
    const service = new DocxInspectService({
      sessionDocs: fakeSessionDocs([SESSION_DOC]),
      sessionFiles: fakeFiles(await DOCX_PROMISE),
      tempFiles: manager,
    });
    const text = await runWithRequestContext({ requestId: "req-docx", uid: "1", startedAt: Date.now() }, () =>
      service.inspect({ chatSessionId: "s1", sessionDocument: "任务书.docx" }),
    );
    expect(text).toContain("Word 文档拆解：任务书.docx");
    expect(text).toContain("页边距");

    // The parser read a real local file: it still exists during the turn...
    const files = await listFiles(baseDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/[\\/]u-[0-9a-f]{16}[\\/]turn-req-docx[\\/]/);
    expect(path.basename(files[0])).toMatch(/\.docx$/);
    const onDisk = await fs.readFile(files[0]);
    expect(new Uint8Array(onDisk)).toEqual(await DOCX_PROMISE);

    // ...and the program-only dispose removes it (tools never get this method).
    await manager.disposeRequest("req-docx");
    expect(files.some((file) => existsSync(file))).toBe(false);
    expect(existsSync(path.dirname(files[0]))).toBe(false);
  });

  it("returns the budget guidance as tool text when the temp quota is exceeded", async () => {
    const tiny = new TempWorkspaceManager({ baseDir, maxFileBytes: 16 });
    try {
      const service = new DocxInspectService({
        sessionDocs: fakeSessionDocs([SESSION_DOC]),
        sessionFiles: fakeFiles(await DOCX_PROMISE),
        tempFiles: tiny,
      });
      const text = await runWithRequestContext({ requestId: "req-budget", uid: "1", startedAt: Date.now() }, () =>
        service.inspect({ chatSessionId: "s1", sessionDocument: "任务书.docx" }),
      );
      expect(text).toContain("单个临时文件超过上限");
      expect(text).not.toContain("Word 文档拆解");
    } finally {
      await tiny.close();
    }
  });

  it("falls back to in-memory parsing when the capability is disabled (no files created)", async () => {
    const disabled = new TempWorkspaceManager({ baseDir, enabled: false });
    try {
      const service = new DocxInspectService({
        sessionDocs: fakeSessionDocs([SESSION_DOC]),
        sessionFiles: fakeFiles(await DOCX_PROMISE),
        tempFiles: disabled,
      });
      const text = await runWithRequestContext({ requestId: "req-off", uid: "1", startedAt: Date.now() }, () =>
        service.inspect({ chatSessionId: "s1", sessionDocument: "任务书.docx" }),
      );
      expect(text).toContain("Word 文档拆解：任务书.docx");
      expect(await listFiles(baseDir)).toHaveLength(0);
    } finally {
      await disabled.close();
    }
  });

  it("falls back to in-memory parsing without a request context (no files created)", async () => {
    const service = new DocxInspectService({
      sessionDocs: fakeSessionDocs([SESSION_DOC]),
      sessionFiles: fakeFiles(await DOCX_PROMISE),
      tempFiles: manager,
    });
    const text = await service.inspect({ chatSessionId: "s1", sessionDocument: "任务书.docx" });
    expect(text).toContain("Word 文档拆解：任务书.docx");
    expect(await listFiles(baseDir)).toHaveLength(0);
  });
});
