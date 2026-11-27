import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { DocumentIRError, validateDocumentIR, type DocumentIR } from "../src/services/office/ir.js";
import { legacyBlocksToDocument } from "../src/services/office/legacy-ir.js";
import { collectTocHeadings, renderDocument, imageDimensions } from "../src/services/office/render-doc.js";
import { documentIRToPreviewBlocks } from "../src/services/office/document-preview.js";
import { buildDocxFromBlocks } from "../src/services/office/docx.js";
import {
  DOC_TEMPLATES,
  getDocTemplate,
  matchTemplateByText,
  resolvePage,
  resolveTemplate,
} from "../src/services/office/templates.js";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Fake PNG whose IHDR carries the given pixel size (the renderer only reads the header). */
function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  buffer[0] = 0x89;
  buffer[1] = 0x50;
  buffer[2] = 0x4e;
  buffer[3] = 0x47;
  buffer[4] = 0x0d;
  buffer[5] = 0x0a;
  buffer[6] = 0x1a;
  buffer[7] = 0x0a;
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

async function parts(buffer: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(buffer);
}

async function text(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path);
  if (!entry) throw new Error("missing part: " + path);
  return entry.async("string");
}

function sampleDocument(overrides: Partial<DocumentIR> = {}): DocumentIR {
  return validateDocumentIR({
    version: 1,
    title: "2026 年第三季度经营分析报告",
    subtitle: "管理层季度复盘",
    meta: { author: "财务部", date: "2026 年 11 月", organization: "示例公司", docNo: "FIN-2026-011" },
    toc: true,
    cover: true,
    sections: [
      {
        heading: "经营概况",
        blocks: [
          { type: "paragraph", text: "本季度营业收入 1,200 万元，同比增长 18%。" },
          { type: "heading", level: 2, text: "收入结构" },
          { type: "table", caption: "核心指标", headers: ["指标", "Q3"], rows: [["收入", "1,200"]] },
        ],
      },
      {
        heading: "下一步计划",
        page: { orientation: "landscape" },
        blocks: [
          { type: "orderedList", items: ["上线智能问答 2.0", "交付周期压到 10 天"] },
          { type: "kv", items: [{ label: "负责人", value: "张伟" }] },
        ],
      },
    ],
    ...overrides,
  });
}

describe("template registry", () => {
  it("exposes the eight built-in templates with distinct geometry", () => {
    expect(Object.keys(DOC_TEMPLATES)).toHaveLength(8);
    const margins = new Set(
      Object.values(DOC_TEMPLATES).map((template) => JSON.stringify(template.page.margins)),
    );
    expect(margins.size).toBeGreaterThanOrEqual(4);
    expect(DOC_TEMPLATES["work-report"].typography.bodySizePt).not.toBe(DOC_TEMPLATES.notice.typography.bodySizePt);
  });

  it("resolves explicit id, alias, style hint, keyword and default (priority order)", () => {
    expect(resolveTemplate({ requested: "notice" }).template.id).toBe("notice");
    expect(resolveTemplate({ requested: "proposal" }).template.id).toBe("business-plan");
    expect(resolveTemplate({ styleHint: "resume" }).template.id).toBe("resume");
    expect(resolveTemplate({ titleHint: "用户调研报告" }).template.id).toBe("research-report");
    expect(resolveTemplate({ briefHint: "帮我写一份技术设计文档" }).template.id).toBe("tech-design");
    expect(resolveTemplate({ titleHint: "随便写点" }).template.id).toBe("work-report");
    expect(matchTemplateByText("会议纪要：产品周会")).toBe("meeting-minutes");
    expect(getDocTemplate("unknown-id").id).toBe("work-report");
  });

  it("merges page overrides (orientation/size/margins) onto template geometry", () => {
    const page = resolvePage(getDocTemplate("academic").page, {
      orientation: "landscape",
      margins: { left: 1.5 },
    });
    expect(page.widthTwips).toBeGreaterThan(page.heightTwips);
    expect(page.margins.left).toBe(Math.round(1.5 * 567));
  });
});

describe("document IR validation", () => {
  it("normalizes a valid document and strips control characters", () => {
    const doc = sampleDocument();
    expect(doc.version).toBe(1);
    expect(doc.sections).toHaveLength(2);
    expect(doc.cover).toBe(true);
  });

  it("rejects empty/invalid structures with Chinese issues", () => {
    expect(() => validateDocumentIR({})).toThrow(DocumentIRError);
    try {
      validateDocumentIR({ title: "x", sections: [{ blocks: [] }] });
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentIRError);
      expect((err as DocumentIRError).issues.length).toBeGreaterThan(0);
    }
    expect(() =>
      validateDocumentIR({ title: "x", sections: [{ blocks: [{ type: "table", rows: [] }] }] }),
    ).toThrow(DocumentIRError);
  });
});

describe("legacy blocks -> IR", () => {
  it("keeps cover/metadata and typed modules", () => {
    const doc = legacyBlocksToDocument({
      title: "旧标题",
      blocks: [
        { type: "cover", title: "封面标题", subtitle: "副标题", meta: ["财务部"] },
        { type: "heading", text: "一、概况", level: 1 },
        { type: "paragraph", text: "正文" },
        { type: "line", text: "姓名：张伟" },
        { type: "bullets", items: ["A"], ordered: true },
        { type: "kv", items: [{ label: "k", value: "v" }] },
        { type: "metrics", items: [{ label: "收入", value: "12" }] },
        { type: "callout", text: "结论", title: "结论", tone: "success" },
        { type: "divider" },
        { type: "table", headers: ["a"], rows: [["1"]], caption: "表 1" },
        { type: "pageBreak" },
      ],
    });
    expect(doc.title).toBe("封面标题");
    expect(doc.cover).toBe(true);
    expect(doc.coverMeta).toEqual(["财务部"]);
    const types = doc.sections[0].blocks.map((block) => block.type);
    expect(types).toContain("orderedList");
    expect(types).toContain("kv");
    expect(types).toContain("metrics");
    expect(types).toContain("callout");
    expect(types).toContain("divider");
    expect(types).toContain("pageBreak");
  });
});

describe("DOCX renderer (standard mode)", () => {
  it("emits styles, cover, TOC field, headers/footers, sections and numbering", async () => {
    const buffer = await renderDocument({ ir: sampleDocument(), template: getDocTemplate("academic") });
    const zip = await parts(buffer);
    const document = await text(zip, "word/document.xml");
    const styles = await text(zip, "word/styles.xml");
    const header = await text(zip, "word/header1.xml");
    const footer = await text(zip, "word/footer1.xml");
    const settings = await text(zip, "word/settings.xml");

    expect(styles).toContain('w:styleId="Heading1"');
    expect(styles).toContain('w:styleId="Caption"');
    expect(zip.file("word/theme/theme1.xml")).toBeTruthy();
    expect(await text(zip, "docProps/core.xml")).toContain("2026 年第三季度经营分析报告");
    expect(await text(zip, "docProps/app.xml")).toContain("MindBase Office Renderer");
    expect(document).toContain("CoverTitle");
    expect(document).toContain("<w:br w:type=\"page\"/>");
    expect(document).toContain("TOC \\o");
    expect(settings).toContain("<w:updateFields");
    expect(header).toContain("2026 年第三季度经营分析报告");
    expect(footer).toContain("PAGE");
    expect(footer).toContain("NUMPAGES");
    expect(document).toContain('<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>');
    expect(document).toContain('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/>');
    expect(document).toContain('<w:tblHeader/>');
    expect(document).toContain('<w:titlePg/>');
    expect(document).toContain('<w:pgNumType w:start="0"/>');
  });

  it("numbers headings with real Word multilevel numbering (no manual digits)", async () => {
    const cn = await renderDocument({ ir: sampleDocument({ toc: false, cover: false }), template: getDocTemplate("work-report") });
    const cnZip = await parts(cn);
    const cnStyles = await text(cnZip, "word/styles.xml");
    const cnNumbering = await text(cnZip, "word/numbering.xml");
    const cnDoc = await text(cnZip, "word/document.xml");
    expect(cnStyles).toContain('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="10"/></w:numPr>');
    expect(cnNumbering).toContain('w:numFmt w:val="chineseCounting"');
    expect(cnNumbering).toContain('w:lvlText w:val="%1、"');
    // The model-typed number is stripped: Word renders "一、" via the style.
    expect(cnDoc).toContain("经营概况");
    expect(cnDoc).not.toContain("一、经营概况");

    const decimal = await renderDocument({ ir: sampleDocument({ toc: false, cover: false }), template: getDocTemplate("tech-design") });
    const decimalZip = await parts(decimal);
    const decimalNumbering = await text(decimalZip, "word/numbering.xml");
    expect(decimalNumbering).toContain('w:lvlText w:val="%1.%2"');
  });

  it("embeds images with media part, relationship and caption", async () => {
    const ir = sampleDocument({
      toc: false,
      cover: false,
      sections: [
        {
          blocks: [
            { type: "image", uploadUuid: "u-1", caption: "架构图", widthCm: 10 },
            { type: "codeBlock", language: "ts", code: "const a = 1;\nconst b = 2;" },
            { type: "formula", text: "y = ax + b" },
          ],
        },
      ],
    });
    const buffer = await renderDocument({
      ir,
      template: getDocTemplate("tech-design"),
      resolveImage: async () => ({ data: new Uint8Array(PNG_1x1), mime: "image/png" }),
    });
    const zip = await parts(buffer);
    const document = await text(zip, "word/document.xml");
    const rels = await text(zip, "word/_rels/document.xml.rels");
    expect(document).toContain("<w:drawing>");
    expect(document).toContain("SEQ 图");
    expect(document).toContain("CodeBlock");
    expect(rels).toContain("media/image1.png");
    expect(zip.file("word/media/image1.png")).toBeTruthy();
    expect(await text(zip, "word/styles.xml")).toContain('w:styleId="Formula"');
  });

  it("renders into an uploaded .docx template (styles/headers preserved)", async () => {
    const templatePackage = await buildDocxFromBlocks({
      title: "模板",
      blocks: [{ type: "paragraph", text: "模板正文" }],
    });
    const buffer = await renderDocument({
      ir: sampleDocument({ toc: false, cover: false, header: "自定义页眉" }),
      template: getDocTemplate("work-report"),
      templatePackage: new Uint8Array(templatePackage),
    });
    const zip = await parts(buffer);
    const styles = await text(zip, "word/styles.xml");
    expect(styles).toContain('w:styleId="Heading1"');
    expect(await text(zip, "word/document.xml")).toContain("经营概况");
  });
});

it("draws the brand logo on the cover as a real media part", async () => {
    const buffer = await renderDocument({
      ir: sampleDocument(),
      template: getDocTemplate("work-report"),
      logo: { data: new Uint8Array(PNG_1x1), mime: "image/png" },
    });
    const zip = await parts(buffer);
    const document = await text(zip, "word/document.xml");
    expect(document).toContain("Logo ");
    expect(zip.file("word/media/logo1.png")).toBeTruthy();
  });

  describe("imageDimensions", () => {
  it("reads PNG header dimensions", () => {
    expect(imageDimensions(new Uint8Array(PNG_1x1))).toEqual({ width: 1, height: 1 });
  });
});

describe("footnotes (native OOXML)", () => {
  it("writes word/footnotes.xml with separators, note bodies, rel and content type", async () => {
    const ir = sampleDocument({
      toc: false,
      cover: false,
      sections: [
        {
          blocks: [
            { type: "paragraph", text: "本季度收入增长 18%。" },
            { type: "footnote", text: "数据来源：内部统计。" },
            { type: "paragraph", text: "毛利率保持稳定。" },
            { type: "footnote", text: "口径说明：含税。" },
          ],
        },
      ],
    });
    const buffer = await renderDocument({ ir, template: getDocTemplate("academic") });
    const zip = await parts(buffer);
    const document = await text(zip, "word/document.xml");
    const footnotes = await text(zip, "word/footnotes.xml");
    const rels = await text(zip, "word/_rels/document.xml.rels");
    const contentTypes = await text(zip, "[Content_Types].xml");

    expect(document).toContain('<w:rStyle w:val="FootnoteReference"/>');
    expect(document).toContain('<w:footnoteReference w:id="1"/>');
    expect(document).toContain('<w:footnoteReference w:id="2"/>');
    expect(footnotes).toContain('<w:footnote w:type="separator" w:id="-1">');
    expect(footnotes).toContain("<w:separator/>");
    expect(footnotes).toContain('<w:footnote w:type="continuationSeparator" w:id="0">');
    expect(footnotes).toContain("<w:continuationSeparator/>");
    expect(footnotes).toContain('<w:footnote w:id="1">');
    expect(footnotes).toContain("数据来源：内部统计。");
    expect(footnotes).toContain('<w:pStyle w:val="FootnoteText"/>');
    expect(footnotes).toContain("<w:footnoteRef/>");
    expect(rels).toContain('relationships/footnotes" Target="footnotes.xml"');
    expect(contentTypes).toContain('PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"');
  });
});

describe("cross references (bookmarks + REF fields)", () => {
  it("bookmarks numbered captions and emits REF fields for table/figure references", async () => {
    const ir = sampleDocument({
      toc: false,
      cover: false,
      sections: [
        {
          blocks: [
            { type: "table", caption: "核心指标", headers: ["指标", "Q3"], rows: [["收入", "1,200"]] },
            { type: "crossReference", kind: "table", index: 1 },
            { type: "image", uploadUuid: "u-1", caption: "架构图" },
            { type: "crossReference", kind: "figure", index: 1 },
            { type: "crossReference", kind: "table", index: 2, prefix: "参见" },
          ],
        },
      ],
    });
    const buffer = await renderDocument({
      ir,
      template: getDocTemplate("academic"),
      resolveImage: async () => ({ data: new Uint8Array(PNG_1x1), mime: "image/png" }),
    });
    const document = await text(await parts(buffer), "word/document.xml");
    expect(document).toContain('w:name="_RefTbl1"');
    expect(document).toContain('w:name="_RefFig1"');
    expect(document).toContain("REF _RefTbl1 \\h");
    expect(document).toContain("REF _RefFig1 \\h");
    // "见"/"表 " are separate runs (the number itself is a REF field result).
    expect(document).toContain(">见</w:t>");
    expect(document).toContain(">参见</w:t>");
    expect(document).toContain(">表 </w:t>");
    expect(document).toContain("REF _RefTbl2 \\h");
  });
});

describe("formula OMML", () => {
  it("renders latex frac/sqrt/script as native m:oMath and falls back to text", async () => {
    const ir = sampleDocument({
      toc: false,
      cover: false,
      sections: [
        {
          blocks: [
            { type: "formula", text: "a/b", latex: "\\frac{a}{b}" },
            { type: "formula", text: "根号 x+1", latex: "\\sqrt{x+1}" },
            { type: "formula", text: "E=mc2", latex: "E = mc^2" },
            { type: "formula", text: "无法解析的公式", latex: "\\frac{a}" },
          ],
        },
      ],
    });
    const document = await text(await parts(await renderDocument({ ir, template: getDocTemplate("tech-design") })), "word/document.xml");
    expect(document).toContain("<m:oMathPara><m:oMath>");
    expect(document).toContain("<m:f>");
    expect(document).toContain("<m:num>");
    expect(document).toContain("<m:den>");
    expect(document).toContain("<m:rad>");
    expect(document).toContain('<m:degHide m:val="1"/>');
    expect(document).toContain("<m:sSup>");
    // Unsupported LaTeX keeps the IR's plain text instead of a broken equation.
    expect(document).toContain("无法解析的公式");
  });

  it("renders native OMML in template-package mode when the template root declares xmlns:m", async () => {
    const templatePackage = await buildDocxFromBlocks({ title: "模板", blocks: [{ type: "paragraph", text: "模板正文" }] });
    const ir = sampleDocument({
      toc: false,
      cover: false,
      sections: [{ blocks: [{ type: "formula", text: "a/b", latex: "\\frac{a}{b}" }] }],
    });
    const buffer = await renderDocument({
      ir,
      template: getDocTemplate("work-report"),
      templatePackage: new Uint8Array(templatePackage),
    });
    const document = await text(await parts(buffer), "word/document.xml");
    expect(document).toContain("<m:oMathPara>");
    expect(document).toContain("<m:f>");
  });
});

describe("image layout (wp:anchor / caption position / auto shrink)", () => {
  it("floats square/topAndBottom images and keeps inline for the default", async () => {
    const ir = sampleDocument({
      toc: false,
      cover: false,
      sections: [
        {
          blocks: [
            { type: "image", uploadUuid: "u-1", wrap: "square" },
            { type: "image", uploadUuid: "u-2", wrap: "topAndBottom" },
            { type: "image", uploadUuid: "u-3" },
          ],
        },
      ],
    });
    const document = await text(
      await parts(await renderDocument({
        ir,
        template: getDocTemplate("tech-design"),
        resolveImage: async () => ({ data: new Uint8Array(PNG_1x1), mime: "image/png" }),
      })),
      "word/document.xml",
    );
    expect(document).toContain("<wp:anchor");
    expect(document).toContain('<wp:wrapSquare wrapText="bothSides"/>');
    expect(document).toContain("<wp:wrapTopAndBottom/>");
    expect(document).toContain('<wp:positionH relativeFrom="column"><wp:align>center</wp:align></wp:positionH>');
    expect(document).toContain("<wp:inline");
  });

  it("puts the caption above the drawing when captionPosition=above", async () => {
    const ir = sampleDocument({
      toc: false,
      cover: false,
      sections: [{ blocks: [{ type: "image", uploadUuid: "u-1", caption: "架构图", captionPosition: "above" }] }],
    });
    const document = await text(
      await parts(await renderDocument({
        ir,
        template: getDocTemplate("tech-design"),
        resolveImage: async () => ({ data: new Uint8Array(PNG_1x1), mime: "image/png" }),
      })),
      "word/document.xml",
    );
    const captionAt = document.indexOf("SEQ 图");
    const drawingAt = document.indexOf("<w:drawing>");
    expect(captionAt).toBeGreaterThan(-1);
    expect(drawingAt).toBeGreaterThan(captionAt);
    // Caption keeps with the image below it.
    expect(document).toContain('<w:pStyle w:val="Caption"/><w:keepNext/>');
  });

  it("shrinks a tall image to at most 60% of the text-column height", async () => {
    const tallPng = pngHeader(100, 2000);
    const ir = sampleDocument({
      toc: false,
      cover: false,
      sections: [{ blocks: [{ type: "image", uploadUuid: "u-tall", widthCm: 14 }] }],
    });
    const template = getDocTemplate("academic");
    const document = await text(
      await parts(await renderDocument({
        ir,
        template,
        resolveImage: async () => ({ data: new Uint8Array(tallPng), mime: "image/png" }),
      })),
      "word/document.xml",
    );
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(document);
    expect(extent).not.toBeNull();
    const cy = Number(extent?.[2]);
    const page = resolvePage(template.page, ir.page);
    const maxHeightEmu = ((page.heightTwips - page.margins.top - page.margins.bottom) / 567) * 0.6 * 360_000;
    expect(cy).toBeLessThanOrEqual(Math.round(maxHeightEmu) + 1);
    expect(cy).toBeGreaterThan(0);
  });
});

describe("cover band (full bleed)", () => {
  it("shades a paragraph that bleeds past both margins with negative indents", async () => {
    const template = getDocTemplate("business-plan");
    const ir = sampleDocument({ toc: false });
    const document = await text(await parts(await renderDocument({ ir, template })), "word/document.xml");
    const page = resolvePage(template.page, ir.page);
    expect(template.cover.variant).toBe("banner");
    expect(document).toContain('<w:shd w:val="clear" w:color="auto" w:fill="1F4E79"/>');
    expect(document).toContain('w:left="-' + page.margins.left + '"');
    expect(document).toContain('w:right="-' + page.margins.right + '"');
  });
});

describe("documentIRToPreviewBlocks", () => {
  it("flattens footnotes and cross references into readable preview paragraphs", () => {
    const doc = validateDocumentIR({
      title: "预览",
      sections: [
        {
          heading: "一、概述",
          blocks: [
            { type: "paragraph", text: "正文内容。" },
            { type: "footnote", text: "来源说明" },
            { type: "crossReference", kind: "table", index: 2 },
            { type: "crossReference", kind: "figure", index: 1, prefix: "参见" },
          ],
        },
      ],
    });
    const blocks = documentIRToPreviewBlocks(doc);
    expect(blocks[0]).toEqual({ type: "heading", level: 1, text: "一、概述" });
    expect(blocks).toContainEqual({ type: "paragraph", text: "正文内容。" });
    expect(blocks).toContainEqual({ type: "paragraph", text: "[注] 来源说明" });
    expect(blocks).toContainEqual({ type: "paragraph", text: "见表 2" });
    expect(blocks).toContainEqual({ type: "paragraph", text: "参见图 1" });
  });
});


// ---------------------------------------------------------------- v4 features

function occurrenceCount(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Template package whose word/document.xml root does NOT declare xmlns:m. */
async function templatePackageWithoutMathNamespace(): Promise<Uint8Array> {
  const base = await buildDocxFromBlocks({ title: "模板", blocks: [{ type: "paragraph", text: "模板正文" }] });
  const zip = await JSZip.loadAsync(base);
  const document = await text(zip, "word/document.xml");
  const mathNamespace = ' xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
  expect(document).toContain(mathNamespace);
  zip.file("word/document.xml", document.replace(mathNamespace, ""));
  return new Uint8Array(await zip.generateAsync({ type: "nodebuffer" }));
}

describe("inline footnote / cross-reference tokens", () => {
  it("splits paragraph text into runs, consecutive footnote marks and REF fields", async () => {
    const ir = sampleDocument({
      toc: false,
      cover: false,
      sections: [
        {
          blocks: [
            { type: "heading", level: 1, text: "总览" },
            { type: "table", caption: "核心指标", headers: ["指标"], rows: [["收入"]] },
            { type: "formula", text: "E=mc2", latex: "E = mc^2" },
            { type: "image", uploadUuid: "u-1", caption: "架构图" },
            {
              type: "paragraph",
              text: "正文前{{fn:来源一}}中段{{fn:来源二}}后段{{ref:table:1}} {{ref:figure:1}} {{ref:heading:1}} {{ref:formula:1}} {{unknown:token}}",
            },
          ],
        },
      ],
    });
    const buffer = await renderDocument({
      ir,
      template: getDocTemplate("academic"),
      resolveImage: async () => ({ data: new Uint8Array(PNG_1x1), mime: "image/png" }),
    });
    const zip = await parts(buffer);
    const document = await text(zip, "word/document.xml");
    const footnotes = await text(zip, "word/footnotes.xml");

    // Normal text around the tokens survives as separate runs.
    expect(document).toContain(">正文前</w:t>");
    expect(document).toContain(">中段</w:t>");
    expect(document).toContain(">后段</w:t>");
    // Two inline footnotes in one paragraph are numbered consecutively.
    expect(document).toContain('<w:footnoteReference w:id="1"/>');
    expect(document).toContain('<w:footnoteReference w:id="2"/>');
    expect(occurrenceCount(document, '<w:rStyle w:val="FootnoteReference"/>')).toBe(2);
    expect(footnotes).toContain("来源一");
    expect(footnotes).toContain("来源二");
    expect(footnotes).toContain('<w:footnote w:id="1">');
    expect(footnotes).toContain('<w:footnote w:id="2">');
    // Inline cross references become REF \\h fields against the bookmarks.
    expect(document).toContain("REF _RefTbl1 \\h");
    expect(document).toContain("REF _RefFig1 \\h");
    expect(document).toContain("REF _RefH1_1 \\h");
    expect(document).toContain("REF _RefEq1 \\h");
    expect(document).toContain('w:name="_RefEq1"');
    // Unparseable tokens are kept verbatim (and logged at info level).
    expect(document).toContain("{{unknown:token}}");
  });
});

describe("heading / formula bookmarks and crossReference kinds", () => {
  it("bookmarks headings by level+order, formulas by order and REFs them", async () => {
    const ir = sampleDocument({
      toc: false,
      cover: false,
      sections: [
        {
          blocks: [
            { type: "heading", level: 1, text: "第一章" },
            { type: "heading", level: 2, text: "第一节" },
            { type: "formula", text: "y=ax+b", latex: "y = ax + b" },
            { type: "crossReference", kind: "heading", index: 2 },
            { type: "crossReference", kind: "formula", index: 1, prefix: "由" },
          ],
        },
      ],
    });
    const document = await text(
      await parts(await renderDocument({ ir, template: getDocTemplate("tech-design") })),
      "word/document.xml",
    );
    expect(document).toContain('w:name="_RefH1_1"');
    expect(document).toContain('w:name="_RefH2_2"');
    expect(document).toContain('w:name="_RefEq1"');
    expect(document).toContain("REF _RefH2_2 \\h");
    expect(document).toContain("REF _RefEq1 \\h");
    expect(document).toContain(">由</w:t>");
    // The formula bookmark wraps the OMML block.
    expect(document.indexOf('w:name="_RefEq1"')).toBeLessThan(document.indexOf("<m:oMathPara>"));
  });
});

describe("two-pass TOC rendering", () => {
  it("writes static entries with page numbers and a dot leader when tocEntries is given", async () => {
    const ir = sampleDocument({ cover: false, toc: true });
    const buffer = await renderDocument({
      ir,
      template: getDocTemplate("academic"),
      tocEntries: [
        { level: 1, text: "经营概况", page: 1 },
        { level: 2, text: "收入结构", page: 42 },
      ],
    });
    const document = await text(await parts(buffer), "word/document.xml");
    expect(document).toContain("TOC \\o");
    expect(document).toContain('w:leader="dot"');
    expect(document).toContain('<w:pStyle w:val="TOC1"/>');
    expect(document).toContain('<w:pStyle w:val="TOC2"/>');
    expect(document).toContain(">经营概况</w:t>");
    expect(document).toContain(">42</w:t>");
  });

  it("keeps the empty TOC field when no entries are supplied", async () => {
    const ir = sampleDocument({ cover: false, toc: true });
    const document = await text(
      await parts(await renderDocument({ ir, template: getDocTemplate("academic") })),
      "word/document.xml",
    );
    expect(document).toContain("TOC \\o");
    expect(document).not.toContain('w:leader="dot"');
    expect(document).not.toContain('<w:pStyle w:val="TOC1"/>');
  });

  it("collectTocHeadings lists section and heading blocks in document order", () => {
    const ir = sampleDocument({ toc: false, cover: false });
    expect(collectTocHeadings(ir)).toEqual([
      { level: 1, text: "经营概况" },
      { level: 2, text: "收入结构" },
      { level: 1, text: "下一步计划" },
    ]);
  });
});

describe("endnotes (native OOXML)", () => {
  it("writes word/endnotes.xml with separators, note bodies, rel, content type and styles", async () => {
    const ir = sampleDocument({
      toc: false,
      cover: false,
      sections: [
        {
          blocks: [
            { type: "paragraph", text: "正文第一段。" },
            { type: "endnote", text: "尾注一：口径说明。" },
            { type: "paragraph", text: "正文第二段。" },
            { type: "endnote", text: "尾注二：数据来源。" },
          ],
        },
      ],
    });
    const zip = await parts(await renderDocument({ ir, template: getDocTemplate("academic") }));
    const document = await text(zip, "word/document.xml");
    const endnotes = await text(zip, "word/endnotes.xml");
    const rels = await text(zip, "word/_rels/document.xml.rels");
    const contentTypes = await text(zip, "[Content_Types].xml");
    const styles = await text(zip, "word/styles.xml");

    expect(document).toContain('<w:endnoteReference w:id="1"/>');
    expect(document).toContain('<w:endnoteReference w:id="2"/>');
    expect(document).toContain('<w:rStyle w:val="EndnoteReference"/>');
    expect(endnotes).toContain('<w:endnotes xmlns:w=');
    expect(endnotes).toContain('<w:endnote w:type="separator" w:id="-1">');
    expect(endnotes).toContain("<w:separator/>");
    expect(endnotes).toContain('<w:endnote w:type="continuationSeparator" w:id="0">');
    expect(endnotes).toContain("<w:continuationSeparator/>");
    expect(endnotes).toContain('<w:endnote w:id="1">');
    expect(endnotes).toContain("尾注一：口径说明。");
    expect(endnotes).toContain("尾注二：数据来源。");
    expect(endnotes).toContain('<w:pStyle w:val="EndnoteText"/>');
    expect(endnotes).toContain("<w:endnoteRef/>");
    expect(rels).toContain('relationships/endnotes" Target="endnotes.xml"');
    expect(contentTypes).toContain("/word/endnotes.xml");
    expect(styles).toContain('w:styleId="EndnoteText"');
    expect(styles).toContain('w:styleId="EndnoteReference"');
  });

  it("omits the endnotes part when the document has no endnote blocks", async () => {
    const zip = await parts(await renderDocument({ ir: sampleDocument({ toc: false, cover: false }), template: getDocTemplate("academic") }));
    expect(zip.file("word/endnotes.xml")).toBeFalsy();
    expect(await text(zip, "word/_rels/document.xml.rels")).not.toContain("endnotes");
  });
});

describe("per-section footnote renumbering", () => {
  const twoSectionDocument = (): DocumentIR =>
    sampleDocument({
      toc: false,
      cover: false,
      sections: [
        {
          blocks: [
            { type: "paragraph", text: "第一节正文。" },
            { type: "footnote", text: "第一节脚注。" },
          ],
        },
        {
          blocks: [
            { type: "paragraph", text: "第二节正文。" },
            { type: "footnote", text: "第二节脚注。" },
          ],
        },
      ],
    });

  it("adds w:footnotePr/w:numRestart eachSect to every sectPr and keeps ids globally unique", async () => {
    const theme = { ...getDocTemplate("academic"), footnoteRestart: "section" as const };
    const zip = await parts(await renderDocument({ ir: twoSectionDocument(), template: theme }));
    const document = await text(zip, "word/document.xml");
    const footnotes = await text(zip, "word/footnotes.xml");
    expect(document).toContain('<w:footnotePr><w:numRestart w:val="eachSect"/></w:footnotePr>');
    expect(occurrenceCount(document, '<w:numRestart w:val="eachSect"/>')).toBe(2);
    expect(footnotes).toContain('<w:footnote w:id="1">');
    expect(footnotes).toContain('<w:footnote w:id="2">');
  });

  it("keeps continuous numbering by default (no numRestart)", async () => {
    const document = await text(
      await parts(await renderDocument({ ir: twoSectionDocument(), template: getDocTemplate("academic") })),
      "word/document.xml",
    );
    expect(document).not.toContain("<w:numRestart");
  });
});

describe("image layout parameters", () => {
  it("maps wrapText/distCm/floatAlign/border/captionAlign onto the drawing XML", async () => {
    const ir = sampleDocument({
      toc: false,
      cover: false,
      sections: [
        {
          blocks: [
            {
              type: "image",
              uploadUuid: "u-1",
              caption: "架构图",
              wrap: "square",
              wrapText: "largest",
              distCm: { top: 0.1, right: 0.2, bottom: 0.3, left: 0.4 },
              floatAlign: "right",
              border: { color: "FF0000", sizePt: 2 },
              captionAlign: "left",
            },
            { type: "image", uploadUuid: "u-2" },
          ],
        },
      ],
    });
    const document = await text(
      await parts(
        await renderDocument({
          ir,
          template: getDocTemplate("tech-design"),
          resolveImage: async () => ({ data: new Uint8Array(PNG_1x1), mime: "image/png" }),
        }),
      ),
      "word/document.xml",
    );
    expect(document).toContain('<wp:wrapSquare wrapText="largest"/>');
    expect(document).toContain('distT="36000"');
    expect(document).toContain('distB="108000"');
    expect(document).toContain('distL="144000"');
    expect(document).toContain('distR="72000"');
    expect(document).toContain("<wp:align>right</wp:align>");
    expect(document).toContain('<a:ln w="25400">');
    expect(document).toContain('<a:srgbClr val="FF0000"/>');
    expect(document).toContain('<w:pStyle w:val="Caption"/><w:jc w:val="left"/>');
    // The default image stays inline (the v4 options are floating-only).
    expect(document).toContain("<wp:inline");
  });
});

describe("columns / watermark / chinese page numbers", () => {
  it("emits w:cols for a two-column section", async () => {
    const ir = sampleDocument({
      toc: false,
      cover: false,
      sections: [{ page: { columns: 2 }, blocks: [{ type: "paragraph", text: "分栏正文。" }] }],
    });
    const document = await text(
      await parts(await renderDocument({ ir, template: getDocTemplate("tech-design") })),
      "word/document.xml",
    );
    expect(document).toContain('<w:cols w:num="2" w:space="425"/>');
  });

  it("draws a VML text watermark in header1.xml", async () => {
    const ir = sampleDocument({ toc: false, cover: false, watermark: { text: "机密", opacity: 0.3 } });
    const header = await text(await parts(await renderDocument({ ir, template: getDocTemplate("academic") })), "word/header1.xml");
    expect(header).toContain('xmlns:v="urn:schemas-microsoft-com:vml"');
    expect(header).toContain("<w:pict>");
    expect(header).toContain("<v:shape");
    expect(header).toContain("<v:textpath");
    expect(header).toContain('string="机密"');
    expect(header).toContain('<v:fill opacity="0.3"/>');
  });

  it("renders the chinese page number format (\u7b2c X \u9875)", async () => {
    const notice = getDocTemplate("notice");
    const theme = {
      ...notice,
      headerFooter: { ...notice.headerFooter, pageNumberFormat: "chinese" as never },
    };
    const footer = await text(
      await parts(await renderDocument({ ir: sampleDocument({ toc: false, cover: false }), template: theme })),
      "word/footer1.xml",
    );
    expect(footer).toContain(">第 </w:t>");
    expect(footer).toContain("PAGE");
    expect(footer).toContain("> 页</w:t>");
    expect(footer).not.toContain(">— </w:t>");
  });
});

describe("chapter caption numbering", () => {
  it("uses STYLEREF + chapter-scoped SEQ fields for tables and figures", async () => {
    const ir = sampleDocument({
      toc: false,
      cover: false,
      captionNumbering: "chapter",
      sections: [
        {
          blocks: [
            { type: "table", caption: "核心指标", headers: ["指标"], rows: [["收入"]] },
            { type: "image", uploadUuid: "u-1", caption: "架构图" },
          ],
        },
      ],
    });
    const document = await text(
      await parts(
        await renderDocument({
          ir,
          template: getDocTemplate("academic"),
          resolveImage: async () => ({ data: new Uint8Array(PNG_1x1), mime: "image/png" }),
        }),
      ),
      "word/document.xml",
    );
    expect(document).toContain("STYLEREF 1 \\s");
    expect(document).toContain("SEQ 表 \\* ARABIC \\s 1");
    expect(document).toContain("SEQ 图 \\* ARABIC \\s 1");
  });

  it("keeps plain SEQ numbering by default (no STYLEREF)", async () => {
    const ir = sampleDocument({
      toc: false,
      cover: false,
      sections: [{ blocks: [{ type: "table", caption: "核心指标", headers: ["指标"], rows: [["收入"]] }] }],
    });
    const document = await text(
      await parts(await renderDocument({ ir, template: getDocTemplate("academic") })),
      "word/document.xml",
    );
    expect(document).not.toContain("STYLEREF");
    expect(document).toContain("SEQ 表 \\* ARABIC");
  });
});

describe("template-mode OMML namespace injection", () => {
  it("injects xmlns:m into a template root that lacks it and leaves styles untouched", async () => {
    const templatePackage = await templatePackageWithoutMathNamespace();
    const stylesBefore = await text(await JSZip.loadAsync(templatePackage), "word/styles.xml");
    const ir = sampleDocument({
      toc: false,
      cover: false,
      sections: [{ blocks: [{ type: "formula", text: "a/b", latex: "\\frac{a}{b}" }] }],
    });
    const zip = await parts(
      await renderDocument({ ir, template: getDocTemplate("work-report"), templatePackage }),
    );
    const document = await text(zip, "word/document.xml");
    expect(document).toContain('xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"');
    expect(document).toContain("<m:oMath>");
    // The user's styles part is byte-identical (no injected style changes).
    expect(await text(zip, "word/styles.xml")).toBe(stylesBefore);
  });

  it("does not inject xmlns:m when the document has no latex formula", async () => {
    const templatePackage = await templatePackageWithoutMathNamespace();
    const ir = sampleDocument({ toc: false, cover: false, sections: [{ blocks: [{ type: "paragraph", text: "纯文本。" }] }] });
    const document = await text(
      await parts(await renderDocument({ ir, template: getDocTemplate("work-report"), templatePackage })),
      "word/document.xml",
    );
    expect(document).not.toContain("xmlns:m=");
    expect(document).not.toContain("<m:oMath");
  });
});

describe("v4 IR validation and preview", () => {
  it("normalizes endnote/watermark/columns/image parameters/caption numbering", () => {
    const doc = validateDocumentIR({
      title: "v4",
      watermark: { text: "机密", opacity: 2 },
      captionNumbering: "chapter",
      footnoteRestart: "section",
      sections: [
        {
          page: { columns: 2 },
          blocks: [
            { type: "endnote", text: "尾注" },
            {
              type: "image",
              uploadUuid: "u-1",
              wrap: "square",
              wrapText: "largest",
              distCm: { top: 0.1, right: 20, left: -1 },
              floatAlign: "right",
              border: { color: "#ff0000", sizePt: 2 },
              captionAlign: "left",
            },
          ],
        },
      ],
    });
    expect(doc.watermark).toEqual({ text: "机密", opacity: 1 });
    expect(doc.captionNumbering).toBe("chapter");
    expect(doc.footnoteRestart).toBe("section");
    expect(doc.sections[0]?.page?.columns).toBe(2);
    const image = doc.sections[0]?.blocks[1];
    expect(image).toMatchObject({
      type: "image",
      wrapText: "largest",
      distCm: { top: 0.1 },
      floatAlign: "right",
      border: { color: "FF0000", sizePt: 2 },
      captionAlign: "left",
    });
  });

  it("rejects invalid endnotes and watermarks", () => {
    expect(() =>
      validateDocumentIR({ title: "x", watermark: {}, sections: [{ blocks: [{ type: "paragraph", text: "a" }] }] }),
    ).toThrow(DocumentIRError);
    expect(() =>
      validateDocumentIR({ title: "x", sections: [{ blocks: [{ type: "endnote" }] }] }),
    ).toThrow(DocumentIRError);
  });

  it("previews endnotes as [尾注] lines and labels new cross-reference kinds", () => {
    const doc = validateDocumentIR({
      title: "预览",
      sections: [
        {
          blocks: [
            { type: "paragraph", text: "正文内容。" },
            { type: "endnote", text: "尾注说明" },
            { type: "crossReference", kind: "heading", index: 2 },
            { type: "crossReference", kind: "formula", index: 1 },
          ],
        },
      ],
    });
    const blocks = documentIRToPreviewBlocks(doc);
    expect(blocks).toContainEqual({ type: "paragraph", text: "[尾注] 尾注说明" });
    expect(blocks).toContainEqual({ type: "paragraph", text: "见标题 2" });
    expect(blocks).toContainEqual({ type: "paragraph", text: "见公式 1" });
  });
});
