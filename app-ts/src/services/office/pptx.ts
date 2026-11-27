import JSZip from "jszip";

import { OfficeExportError } from "./errors.js";
import { XML_DECL, clampText, parseInline, xmlEscape } from "./ooxml.js";
import { OFFICE_LIMITS, type InlineRun, type PptxSlide, type PptxTable } from "./types.js";

/**
 * PowerPoint (.pptx) builder: 16:9 deck with four visual variants (cover,
 * section divider, bullet content, data table) authored directly as
 * PresentationML.
 *
 * Why hand-authored: app-ts runs from TypeScript with no bundler and the
 * deployment image ships no office libraries, so a generator (pptxgenjs) would
 * add a dependency tree for a feature whose layout we control anyway. The
 * package keeps exactly one master + one blank layout: every slide draws its own
 * text boxes and tables at absolute coordinates, which is why no placeholder
 * inheritance is needed and why the same code renders identically in PowerPoint,
 * Keynote and LibreOffice.
 *
 * Not supported on purpose: images/video (media parts + relationship rewiring),
 * speaker notes (notesSlide parts), and per-slide master/layout switches.
 */

const EMU_PER_INCH = 914_400;
const SLIDE_W = 12_192_000; // 13.333in
const SLIDE_H = 6_858_000; // 7.5in

const COLOR = {
  ink: "1F2937",
  body: "374151",
  muted: "6B7280",
  subtle: "9CA3AF",
  accent: "4472C4",
  accentSoft: "E8EEF7",
  coverBg: "1F2937",
  coverInk: "FFFFFF",
  coverMuted: "CBD5E1",
  surface: "F8FAFC",
  zebra: "F3F6FB",
  white: "FFFFFF",
} as const;

const emu = (inches: number) => Math.round(inches * EMU_PER_INCH);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const CONTENT_TITLE: Box = { x: 0.75, y: 0.45, w: 11.83, h: 0.95 };
const ACCENT_BAR: Box = { x: 0.75, y: 1.4, w: 0.9, h: 0.07 };
const CONTENT_BODY: Box = { x: 0.75, y: 1.75, w: 11.83, h: 4.85 };
const FOOTER: Box = { x: 0.75, y: 6.85, w: 9.5, h: 0.3 };
const PAGE_NO: Box = { x: 11.6, y: 6.85, w: 1.0, h: 0.3 };

function xfrm(box: Box): string {
  return (
    "<a:xfrm><a:off x=\"" + emu(box.x) + "\" y=\"" + emu(box.y) + "\"/>" +
    "<a:ext cx=\"" + emu(box.w) + "\" cy=\"" + emu(box.h) + "\"/></a:xfrm>"
  );
}

function solidFill(color: string): string {
  return "<a:solidFill><a:srgbClr val=\"" + color + "\"/></a:solidFill>";
}

interface ShapeOptions {
  fill?: string;
  /** No outline (defaults to none for text boxes, a hairline for panels). */
  line?: string;
  /** Body text; omitted = a pure decorative panel. */
  body?: string;
  /** Text inset in inches; text boxes default to 0 (positions are authored). */
  inset?: number;
  anchor?: "t" | "ctr" | "b";
  txBox?: boolean;
}

function shape(id: number, name: string, box: Box, options: ShapeOptions = {}): string {
  const inset = options.inset ?? 0;
  const line = options.line ? "<a:ln><a:solidFill><a:srgbClr val=\"" + options.line + "\"/></a:solidFill></a:ln>" : "<a:ln><a:noFill/></a:ln>";
  const spPr =
    "<p:spPr>" +
    xfrm(box) +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    (options.fill ? solidFill(options.fill) : "<a:noFill/>") +
    line +
    "</p:spPr>";
  const txBox = options.txBox === false ? "" : ' txBox="1"';
  const nv =
    "<p:nvSpPr><p:cNvPr id=\"" + id + "\" name=\"" + xmlEscape(name) + "\"/>" +
    "<p:cNvSpPr" + txBox + "/><p:nvPr/></p:nvSpPr>";
  if (!options.body) return "<p:sp>" + nv + spPr + "</p:sp>";
  const bodyPr =
    '<a:bodyPr wrap="square" lIns="' + emu(inset) + '" tIns="' + emu(inset) +
    '" rIns="' + emu(inset) + '" bIns="' + emu(inset) + '" anchor="' + (options.anchor ?? "t") + '">' +
    "<a:normAutofit/></a:bodyPr>";
  return "<p:sp>" + nv + spPr + "<p:txBody>" + bodyPr + "<a:lstStyle/>" + options.body + "</p:txBody></p:sp>";
}

interface ParaOptions {
  /** points */
  size: number;
  color?: string;
  bold?: boolean;
  align?: "l" | "ctr" | "r";
  /** bullet glyph + marL/indent; omitted = no bullet */
  bullet?: string;
  bulletColor?: string;
  /** points of space before the paragraph */
  spaceBefore?: number;
  /** line spacing in percent (default 100) */
  lineSpacing?: number;
}

function runXml(run: InlineRun, options: ParaOptions): string {
  const props: string[] = ['lang="zh-CN"', 'sz="' + Math.round(options.size * 100) + '"', 'dirty="0"'];
  if (run.bold || options.bold) props.push('b="1"');
  if (run.italic) props.push('i="1"');
  if (run.code) props.push('spc="20"');
  const color = run.code ? COLOR.accent : options.color ?? COLOR.body;
  // Slide text is single-line by design (newlines become spaces); explicit line
  // breaks inside a run would need extra a:br plumbing for no visual gain.
  const text = xmlEscape(run.text).replace(/\s*\n\s*/g, " ");
  return "<a:r><a:rPr " + props.join(" ") + ">" + solidFill(color) +
    (run.code ? '<a:latin typeface="Consolas"/><a:ea typeface="Consolas"/>' : "") +
    "</a:rPr><a:t>" + text + "</a:t></a:r>";
}

function paragraphXml(text: string, options: ParaOptions): string {
  const pPr: string[] = [];
  const runProps: string[] = [];
  if (options.align) runProps.push('algn="' + options.align + '"');
  if (options.bullet) {
    runProps.push('marL="285750"', 'indent="-285750"');
    pPr.push('<a:buClr><a:srgbClr val="' + (options.bulletColor ?? COLOR.accent) + '"/></a:buClr>');
    pPr.push('<a:buFont typeface="Arial"/>');
    pPr.push('<a:buChar char="' + xmlEscape(options.bullet) + '"/>');
  } else {
    runProps.push('marL="0"', 'indent="0"');
    pPr.push("<a:buNone/>");
  }
  if (options.spaceBefore !== undefined) pPr.push('<a:spcBef><a:spcPts val="' + Math.round(options.spaceBefore * 100) + '"/></a:spcBef>');
  if (options.lineSpacing !== undefined) pPr.push('<a:lnSpc><a:spcPct val="' + Math.round(options.lineSpacing * 1000) + '"/></a:lnSpc>');
  const pPrXml = runProps.length > 0 || pPr.length > 0
    ? "<a:pPr" + (runProps.length > 0 ? " " + runProps.join(" ") : "") + ">" + pPr.join("") + "</a:pPr>"
    : "";
  const runs = parseInline(text).map((run) => runXml(run, options)).join("");
  return "<a:p>" + pPrXml + (runs || "<a:endParaRPr lang=\"zh-CN\"/>") + "</a:p>";
}

/** Table: explicit cell fills (no tableStyle part), header band + zebra body. */
function tableXml(table: PptxTable, box: Box, idBase: number): string {
  const header = table.headers ?? [];
  const rows = table.rows.slice(0, OFFICE_LIMITS.pptxTableRows);
  const columns = Math.max(header.length, ...rows.map((row) => row.length), 1);
  const weights = table.widths && table.widths.length > 0
    ? Array.from({ length: columns }, (_, index) => Math.max(1, table.widths?.[index] ?? 1))
    : Array.from({ length: columns }, () => 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const totalEmu = emu(box.w);
  const colWidths = weights.map((weight) => Math.round((weight / totalWeight) * totalEmu));

  const fontSize = rows.length > 12 ? 10 : rows.length > 8 ? 11 : 12;
  const headerHeight = emu(0.42);
  const rowHeight = emu(rows.length > 10 ? 0.3 : 0.36);

  const grid = "<a:tblGrid>" + colWidths.map((width) => '<a:gridCol w="' + width + '"/>').join("") + "</a:tblGrid>";
  const cell = (text: string, width: number, fill: string, color: string, bold: boolean, height: number) => {
    const body =
      "<a:bodyPr/><a:lstStyle/>" +
      paragraphXml(text, { size: fontSize, color, bold, align: "l", lineSpacing: 100 });
    const border = "<a:lnL w=\"6350\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:srgbClr val=\"" + COLOR.white + "\"/></a:solidFill></a:lnL>" +
      "<a:lnR w=\"6350\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:srgbClr val=\"" + COLOR.white + "\"/></a:solidFill></a:lnR>" +
      "<a:lnT w=\"6350\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:srgbClr val=\"" + COLOR.white + "\"/></a:solidFill></a:lnT>" +
      "<a:lnB w=\"6350\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:srgbClr val=\"" + COLOR.white + "\"/></a:solidFill></a:lnB>";
    return (
      "<a:tc><a:txBody>" + body + "</a:txBody>" +
      "<a:tcPr marL=\"" + emu(0.08) + "\" marR=\"" + emu(0.08) + "\" marT=\"" + emu(0.04) + "\" marB=\"" + emu(0.04) + "\" anchor=\"ctr\">" +
      border + solidFill(fill) + "</a:tcPr></a:tc>"
    );
  };

  const trs: string[] = [];
  if (header.length > 0) {
    trs.push(
      "<a:tr h=\"" + headerHeight + "\">" +
        colWidths.map((width, index) => cell(header[index] ?? "", width, COLOR.accent, COLOR.white, true, headerHeight)).join("") +
        "</a:tr>",
    );
  }
  rows.forEach((row, rowIndex) => {
    const fill = rowIndex % 2 === 1 ? COLOR.zebra : COLOR.white;
    trs.push(
      "<a:tr h=\"" + rowHeight + "\">" +
        colWidths.map((width, index) => cell(row[index] ?? "", width, fill, COLOR.body, false, rowHeight)).join("") +
        "</a:tr>",
    );
  });

  return (
    "<p:graphicFrame><p:nvGraphicFramePr>" +
    "<p:cNvPr id=\"" + idBase + "\" name=\"table\"/>" +
    "<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp=\"1\"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>" +
    "<p:xfrm>" + "<a:off x=\"" + emu(box.x) + "\" y=\"" + emu(box.y) + "\"/>" +
    "<a:ext cx=\"" + totalEmu + "\" cy=\"" + (header.length > 0 ? headerHeight : 0) + rowHeight * rows.length + "\"/></p:xfrm>" +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
    '<a:tbl><a:tblPr firstRow="1" bandRow="1"/>' + grid + trs.join("") + "</a:tbl>" +
    "</a:graphicData></a:graphic></p:graphicFrame>"
  );
}

function slideKind(slide: PptxSlide, index: number, total: number): "title" | "section" | "content" | "table" {
  if (slide.kind) return slide.kind;
  if (index === 0 && total > 1) return "title";
  if (slide.table) return "table";
  if (!slide.bullets?.length && !slide.paragraphs?.length && slide.subtitle) return "section";
  return "content";
}

function coverSlide(slide: PptxSlide): string {
  const shapes: string[] = [];
  shapes.push(shape(2, "cover background", { x: 0, y: 0, w: 13.333, h: 7.5 }, { fill: COLOR.coverBg, txBox: false }));
  shapes.push(shape(3, "accent rule", { x: 0.9, y: 2.95, w: 1.5, h: 0.1 }, { fill: COLOR.accent, txBox: false }));
  shapes.push(
    shape(4, "cover title", { x: 0.9, y: 1.55, w: 11.5, h: 1.3 }, {
      body: paragraphXml(slide.title, { size: 40, bold: true, color: COLOR.coverInk, lineSpacing: 95 }),
    }),
  );
  const subtitle = slide.subtitle ?? slide.bullets?.join(" · ") ?? "";
  if (subtitle) {
    shapes.push(
      shape(5, "cover subtitle", { x: 0.9, y: 3.25, w: 11.5, h: 1.4 }, {
        body: paragraphXml(subtitle, { size: 18, color: COLOR.coverMuted, lineSpacing: 120 }),
      }),
    );
  }
  return shapes.join("");
}

function sectionSlide(slide: PptxSlide): string {
  const shapes: string[] = [];
  shapes.push(shape(2, "section background", { x: 0, y: 0, w: 13.333, h: 7.5 }, { fill: COLOR.surface, txBox: false }));
  shapes.push(shape(3, "accent rule", { x: 0.9, y: 2.5, w: 1.2, h: 0.09 }, { fill: COLOR.accent, txBox: false }));
  shapes.push(
    shape(4, "section title", { x: 0.9, y: 2.75, w: 11.5, h: 1.2 }, {
      body: paragraphXml(slide.title, { size: 34, bold: true, color: COLOR.ink }),
    }),
  );
  const subtitle = slide.subtitle ?? slide.bullets?.join(" · ") ?? "";
  if (subtitle) {
    shapes.push(
      shape(5, "section subtitle", { x: 0.9, y: 4.05, w: 11.5, h: 1.2 }, {
        body: paragraphXml(subtitle, { size: 16, color: COLOR.muted }),
      }),
    );
  }
  return shapes.join("");
}

function contentSlide(slide: PptxSlide, page: string, footer: string | undefined): string {
  const shapes: string[] = [];
  shapes.push(shape(2, "title", CONTENT_TITLE, {
    body: paragraphXml(slide.title, { size: 26, bold: true, color: COLOR.ink, lineSpacing: 95 }),
    anchor: "b",
  }));
  shapes.push(shape(3, "accent rule", ACCENT_BAR, { fill: COLOR.accent, txBox: false }));

  const paragraphs: string[] = [];
  for (const text of slide.paragraphs ?? []) {
    paragraphs.push(paragraphXml(text, { size: 15, color: COLOR.body, lineSpacing: 130, spaceBefore: 4 }));
  }
  for (const bullet of (slide.bullets ?? []).slice(0, OFFICE_LIMITS.pptxBullets)) {
    paragraphs.push(paragraphXml(bullet, { size: 16, color: COLOR.body, bullet: "•", lineSpacing: 130, spaceBefore: 8 }));
  }
  if (paragraphs.length > 0) {
    shapes.push(shape(4, "body", CONTENT_BODY, { body: paragraphs.join("") }));
  }
  if (slide.table) {
    const tableTop = paragraphs.length > 0 ? CONTENT_BODY.y + 0.2 : CONTENT_BODY.y;
    shapes.push(tableXml(slide.table, { x: CONTENT_BODY.x, y: tableTop, w: CONTENT_BODY.w, h: 4.2 }, 5));
  }
  if (footer) {
    shapes.push(shape(90, "footer", FOOTER, {
      body: paragraphXml(footer, { size: 9, color: COLOR.subtle }),
    }));
  }
  shapes.push(shape(91, "page number", PAGE_NO, {
    body: paragraphXml(page, { size: 9, color: COLOR.subtle, align: "r" }),
  }));
  return shapes.join("");
}

function tableSlide(slide: PptxSlide, page: string, footer: string | undefined): string {
  const shapes: string[] = [];
  shapes.push(shape(2, "title", CONTENT_TITLE, {
    body: paragraphXml(slide.title, { size: 26, bold: true, color: COLOR.ink, lineSpacing: 95 }),
    anchor: "b",
  }));
  shapes.push(shape(3, "accent rule", ACCENT_BAR, { fill: COLOR.accent, txBox: false }));
  if (slide.table) {
    shapes.push(tableXml(slide.table, { x: CONTENT_BODY.x, y: CONTENT_BODY.y, w: CONTENT_BODY.w, h: 4.6 }, 4));
  }
  if (footer) {
    shapes.push(shape(90, "footer", FOOTER, { body: paragraphXml(footer, { size: 9, color: COLOR.subtle }) }));
  }
  shapes.push(shape(91, "page number", PAGE_NO, {
    body: paragraphXml(page, { size: 9, color: COLOR.subtle, align: "r" }),
  }));
  return shapes.join("");
}

function slideXml(slide: PptxSlide, index: number, total: number, footer: string | undefined): string {
  const kind = slideKind(slide, index, total);
  const page = String(index + 1) + " / " + String(total);
  const body =
    kind === "title"
      ? coverSlide(slide)
      : kind === "section"
        ? sectionSlide(slide)
        : kind === "table"
          ? tableSlide(slide, page, footer)
          : contentSlide(slide, page, footer);
  return (
    XML_DECL +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
    ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    "<p:cSld><p:spTree>" +
    "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>" +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    body +
    "</p:spTree></p:cSld>" +
    "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
  );
}

const CONTENT_TYPES_XML = (slideCount: number) =>
  XML_DECL +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
  '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
  '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
  '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
  Array.from({ length: slideCount }, (_, index) =>
    '<Override PartName="/ppt/slides/slide' + (index + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
  ).join("") +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  "</Types>";

const PACKAGE_RELS_XML =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  "</Relationships>";

const PRESENTATION_XML = (slideCount: number) =>
  XML_DECL +
  '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
  ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
  ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">' +
  '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
  "<p:sldIdLst>" +
  Array.from({ length: slideCount }, (_, index) =>
    '<p:sldId id="' + (256 + index) + '" r:id="rId' + (index + 2) + '"/>',
  ).join("") +
  "</p:sldIdLst>" +
  '<p:sldSz cx="' + SLIDE_W + '" cy="' + SLIDE_H + '"/>' +
  '<p:notesSz cx="6858000" cy="9144000"/>' +
  '<p:defaultTextStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr></p:defaultTextStyle>' +
  "</p:presentation>";

const PRESENTATION_RELS_XML = (slideCount: number) =>
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
  Array.from({ length: slideCount }, (_, index) =>
    '<Relationship Id="rId' + (index + 2) +
    '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' +
    (index + 1) + '.xml"/>',
  ).join("") +
  "</Relationships>";

const SLIDE_MASTER_XML =
  XML_DECL +
  '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
  ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
  ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
  "<p:cSld><p:spTree>" +
  "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>" +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  "</p:spTree></p:cSld>" +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"' +
  ' accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  "<p:txStyles>" +
  '<p:titleStyle><a:lvl1pPr><a:defRPr lang="zh-CN" sz="2600" b="1"/></a:lvl1pPr></p:titleStyle>' +
  '<p:bodyStyle><a:lvl1pPr><a:defRPr lang="zh-CN" sz="1600"/></a:lvl1pPr></p:bodyStyle>' +
  '<p:otherStyle><a:lvl1pPr><a:defRPr lang="zh-CN" sz="1200"/></a:lvl1pPr></p:otherStyle>' +
  "</p:txStyles>" +
  "</p:sldMaster>";

const SLIDE_MASTER_RELS_XML =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
  "</Relationships>";

const SLIDE_LAYOUT_XML =
  XML_DECL +
  '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
  ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
  ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">' +
  '<p:cSld name="Blank"><p:spTree>' +
  "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>" +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  "</p:spTree></p:cSld>" +
  "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>";

const SLIDE_LAYOUT_RELS_XML =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
  "</Relationships>";

const THEME_XML =
  XML_DECL +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="MindBase">' +
  "<a:themeElements>" +
  '<a:clrScheme name="MindBase">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="1F2937"/></a:dk2>' +
  '<a:lt2><a:srgbClr val="F8FAFC"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4472C4"/></a:accent1>' +
  '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>' +
  '<a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>' +
  '<a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
  '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
  "</a:clrScheme>" +
  '<a:fontScheme name="MindBase">' +
  '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:minorFont>' +
  "</a:fontScheme>" +
  '<a:fmtScheme name="MindBase">' +
  "<a:fillStyleLst>" +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  "</a:fillStyleLst>" +
  "<a:lnStyleLst>" +
  '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
  '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
  '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
  "</a:lnStyleLst>" +
  "<a:effectStyleLst>" +
  "<a:effectStyle><a:effectLst/></a:effectStyle>" +
  "<a:effectStyle><a:effectLst/></a:effectStyle>" +
  "<a:effectStyle><a:effectLst/></a:effectStyle>" +
  "</a:effectStyleLst>" +
  "<a:bgFillStyleLst>" +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  "</a:bgFillStyleLst>" +
  "</a:fmtScheme>" +
  "</a:themeElements>" +
  "<a:objectDefaults/><a:extraClrSchemeLst/>" +
  "</a:theme>";

function coreXml(title: string, now: Date): string {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    XML_DECL +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
    ' xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    "<dc:title>" + xmlEscape(title) + "</dc:title>" +
    "<dc:creator>MindBase</dc:creator><cp:lastModifiedBy>MindBase</cp:lastModifiedBy>" +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + iso + "</dcterms:created>" +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + iso + "</dcterms:modified>" +
    "</cp:coreProperties>"
  );
}

const APP_XML =
  XML_DECL +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"' +
  ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  "<Application>MindBase</Application><Slides>0</Slides>" +
  "</Properties>";

/** Builds the .pptx package. */
export async function buildPptx(options: {
  title: string;
  slides: PptxSlide[];
  footer?: string;
  now?: Date;
}): Promise<Buffer> {
  const slides = options.slides ?? [];
  if (slides.length === 0) throw new OfficeExportError("invalid", "PPT 内容为空：至少需要一页幻灯片");
  if (slides.length > OFFICE_LIMITS.pptxSlides) {
    throw new OfficeExportError("invalid", "页数超过 " + OFFICE_LIMITS.pptxSlides + " 页上限");
  }

  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML(slides.length));
  zip.file("_rels/.rels", PACKAGE_RELS_XML);
  zip.file("ppt/presentation.xml", PRESENTATION_XML(slides.length));
  zip.file("ppt/_rels/presentation.xml.rels", PRESENTATION_RELS_XML(slides.length));
  zip.file("ppt/slideMasters/slideMaster1.xml", SLIDE_MASTER_XML);
  zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", SLIDE_MASTER_RELS_XML);
  zip.file("ppt/slideLayouts/slideLayout1.xml", SLIDE_LAYOUT_XML);
  zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", SLIDE_LAYOUT_RELS_XML);
  zip.file("ppt/theme/theme1.xml", THEME_XML);
  slides.forEach((slide, index) => {
    zip.file("ppt/slides/slide" + (index + 1) + ".xml", slideXml(slide, index, slides.length, options.footer));
    zip.file(
      "ppt/slides/_rels/slide" + (index + 1) + ".xml.rels",
      XML_DECL +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
        "</Relationships>",
    );
  });
  zip.file("docProps/core.xml", coreXml(options.title, options.now ?? new Date()));
  zip.file("docProps/app.xml", APP_XML);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
