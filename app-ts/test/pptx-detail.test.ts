import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  MAX_PPTX_BYTES,
  MAX_ZIP_ENTRIES,
  PptxDetailError,
  parsePptxDetail,
  renderPptxDetailText,
} from "../src/doc-parser/pptx-detail.js";

/**
 * pptx detail inspection: the OOXML fixtures are hand-built with JSZip (no
 * binary deck is committed) and cover exactly what the second parsing level
 * claims to read - slide order via sldIdLst + rels, title / ctrTitle
 * placeholders, multi-run paragraphs, a table (header row + body rows), picture
 * and chart counts, slide size - plus the fallback order and guard paths
 * (corrupt zip, oversized file, too many parts, empty deck). Offline only.
 */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart";

const GROUP_MARKERS =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';

function titleShape(text: string, kind: string): string {
  return (
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="标题"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="' + kind + '"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>' +
    text +
    "</a:t></a:r></a:p></p:txBody></p:sp>"
  );
}

function slideXml(inner: string): string {
  return (
    XML_DECL +
    '<p:sld xmlns:a="' +
    A_NS +
    '" xmlns:r="' +
    R_NS +
    '" xmlns:p="' +
    P_NS +
    '"><p:cSld><p:spTree>' +
    GROUP_MARKERS +
    inner +
    "</p:spTree></p:cSld></p:sld>"
  );
}

const BODY_SHAPE =
  '<p:sp><p:nvSpPr><p:cNvPr id="3" name="正文"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>' +
  '<p:txBody><a:bodyPr/><a:lstStyle/>' +
  '<a:p><a:r><a:rPr lang="zh-CN"/><a:t>第一段</a:t></a:r><a:r><a:t>文本</a:t></a:r></a:p>' +
  '<a:p><a:r><a:t>第二段文本</a:t></a:r></a:p>' +
  '<a:p><a:r><a:t>   </a:t></a:r></a:p>' +
  "</p:txBody></p:sp>";

const TABLE_FRAME =
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="表格"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
  '<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid>' +
  '<a:tr><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>指标</a:t></a:r></a:p></a:txBody></a:tc>' +
  '<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>数值</a:t></a:r></a:p></a:txBody></a:tc></a:tr>' +
  '<a:tr><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>营收</a:t></a:r></a:p></a:txBody></a:tc>' +
  '<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>100</a:t></a:r></a:p></a:txBody></a:tc></a:tr>' +
  '<a:tr><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>利润</a:t></a:r></a:p></a:txBody></a:tc>' +
  '<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>20</a:t></a:r></a:p></a:txBody></a:tc></a:tr>' +
  "</a:tbl></a:graphicData></a:graphic></p:graphicFrame>";

const PICTURE =
  '<p:pic><p:nvPicPr><p:cNvPr id="7" name="图片 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
  '<p:blipFill><a:blip r:embed="rId8"/></p:blipFill><p:spPr/></p:pic>';

const CHART_FRAME =
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="8" name="图表 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
  '<c:chart xmlns:c="' +
  C_NS +
  '" r:id="rId9"/></a:graphicData></a:graphic></p:graphicFrame>';

/** Content slide (slide1 part): title + body text + table. */
const SLIDE_CONTENT = slideXml(titleShape("第一章 背景", "title") + BODY_SHAPE + TABLE_FRAME);
/** Cover slide (slide2 part but FIRST in presentation order): ctrTitle + picture + chart. */
const SLIDE_COVER = slideXml(titleShape("年度总结", "ctrTitle") + PICTURE + CHART_FRAME);

const PRESENTATION =
  XML_DECL +
  '<p:presentation xmlns:a="' +
  A_NS +
  '" xmlns:r="' +
  R_NS +
  '" xmlns:p="' +
  P_NS +
  '"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst>' +
  '<p:sldSz cx="12192000" cy="6858000" type="screen16x9"/></p:presentation>';

/** rId2 -> slide2 (cover) first, rId3 -> slide1 (content) second: page order != file name order. */
const PRESENTATION_RELS =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
  "</Relationships>";

interface PptxFixtureOptions {
  presentation?: boolean;
  rels?: boolean;
}

async function makePptx(options: PptxFixtureOptions = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("ppt/slides/slide1.xml", SLIDE_CONTENT);
  zip.file("ppt/slides/slide2.xml", SLIDE_COVER);
  if (options.presentation !== false) zip.file("ppt/presentation.xml", PRESENTATION);
  if (options.rels !== false) zip.file("ppt/_rels/presentation.xml.rels", PRESENTATION_RELS);
  return zip.generateAsync({ type: "nodebuffer" });
}

const PPTX_PROMISE = makePptx();

describe("parsePptxDetail", () => {
  it("按 presentation.xml + rels 的页序解析标题、文本、表格与对象统计", async () => {
    const detail = await parsePptxDetail(await PPTX_PROMISE);
    expect(detail.slideCount).toBe(2);
    expect(detail.slideWidthEmu).toBe(12192000);
    expect(detail.slideHeightEmu).toBe(6858000);
    expect(detail.slides.map((slide) => slide.index)).toEqual([1, 2]);

    const cover = detail.slides[0];
    expect(cover.title).toBe("年度总结");
    expect(cover.texts).toEqual([]);
    expect(cover.shapeCount).toBe(1);
    expect(cover.pictureCount).toBe(1);
    expect(cover.hasChart).toBe(true);

    const content = detail.slides[1];
    expect(content.title).toBe("第一章 背景");
    expect(content.texts).toEqual(["第一段文本", "第二段文本"]);
    expect(content.shapeCount).toBe(2);
    expect(content.pictureCount).toBe(0);
    expect(content.hasChart).toBe(false);
    expect(content.tables).toHaveLength(1);
    expect(content.tables[0].headers).toEqual(["指标", "数值"]);
    expect(content.tables[0].rows).toEqual([
      ["营收", "100"],
      ["利润", "20"],
    ]);
  });

  it("rels 缺失时退回 slideN 数字排序", async () => {
    const detail = await parsePptxDetail(await makePptx({ rels: false }));
    expect(detail.slides.map((slide) => slide.title)).toEqual(["第一章 背景", "年度总结"]);
  });

  it("presentation.xml 缺失时退回数字排序（slide2 在 slide10 之前）", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide2.xml", SLIDE_CONTENT);
    zip.file("ppt/slides/slide10.xml", SLIDE_COVER);
    const detail = await parsePptxDetail(await zip.generateAsync({ type: "nodebuffer" }));
    expect(detail.slideCount).toBe(2);
    expect(detail.slides.map((slide) => slide.title)).toEqual(["第一章 背景", "年度总结"]);
    expect(detail.slideWidthEmu).toBeUndefined();
  });

  it("空文件 / 损坏 zip / 超过大小上限 / 部件过多 / 没有幻灯片都抛清晰错误", async () => {
    await expect(parsePptxDetail(Buffer.alloc(0))).rejects.toThrow(/文件为空/);
    await expect(parsePptxDetail(Buffer.from("this is not a zip"))).rejects.toBeInstanceOf(PptxDetailError);
    await expect(parsePptxDetail(Buffer.from("this is not a zip"))).rejects.toThrow(/无法打开 PowerPoint 包/);

    const oversized = Buffer.alloc(MAX_PPTX_BYTES + 1);
    await expect(parsePptxDetail(oversized)).rejects.toThrow(/文件过大/);

    const manyParts = new JSZip();
    for (let index = 0; index <= MAX_ZIP_ENTRIES; index += 1) {
      manyParts.file("parts/file" + index + ".xml", "<x/>");
    }
    await expect(parsePptxDetail(await manyParts.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/部件过多/);

    const noSlides = new JSZip();
    noSlides.file("ppt/presentation.xml", PRESENTATION);
    await expect(parsePptxDetail(await noSlides.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/没有幻灯片/);
  });
});

describe("renderPptxDetailText", () => {
  it("输出中文摘要：概览、尺寸、标题、对象统计、文本与表格", async () => {
    const text = renderPptxDetailText(await parsePptxDetail(await PPTX_PROMISE));
    expect(text).toContain("【PPT 概览】");
    expect(text).toContain("幻灯片：2 页");
    expect(text).toContain("16:9");
    expect(text).toContain("【第 1 页】 年度总结");
    expect(text).toContain("图片 1");
    expect(text).toContain("图表：是");
    expect(text).toContain("【第 2 页】 第一章 背景");
    expect(text).toContain("- 第一段文本");
    expect(text).toContain("图表：无");
    expect(text).toContain("| 指标 | 数值 |");
    expect(text).toContain("| 营收 | 100 |");
    expect(text).toContain("| 利润 | 20 |");
  });

  it("遵守 maxChars 与 maxSlides 预算", async () => {
    const detail = await parsePptxDetail(await PPTX_PROMISE);
    const clipped = renderPptxDetailText(detail, { maxChars: 120 });
    expect(clipped.length).toBeLessThanOrEqual(120);
    expect(clipped).toContain("已截断");

    const oneSlide = renderPptxDetailText(detail, { maxSlides: 1 });
    expect(oneSlide).toContain("【第 1 页】");
    expect(oneSlide).not.toContain("【第 2 页】");
    expect(oneSlide).toContain("页已省略");
  });
});
