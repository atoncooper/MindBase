import JSZip from "jszip";

/**
 * Word (.docx) package authoring + the document theme system used by
 * office_export (contract: docs/office-export.md) and the manuscript exporter.
 *
 * Layer: service-domain pure module; no HTTP, no repositories, no cloud calls.
 * READ half (docx bytes -> text / layout / blocks) lives in src/doc-parser/docx*.ts.
 *
 * Two layers:
 *  - THEME: page margins, body size/indent/spacing, heading hierarchy, table and
 *    caption typography, accent colour. Four presets (report / proposal / resume /
 *    brief) so the model picks a designed layout instead of inventing spacing.
 *  - PACKAGE: standard mode authors every part (styles/numbering/page-number
 *    footer); template mode replaces only word/document.xml so the user's own
 *    styles, headers, page setup and numbering survive.
 *
 * No new dependency: jszip is already used by the doc-parser.
 */

export interface DocxSectionInput {
  title: string;
  content?: string;
}

export interface BuildDocxOptions {
  title?: string;
  sections: DocxSectionInput[];
  template?: Uint8Array;
}

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export type DocxThemeName = "report" | "proposal" | "resume" | "brief";

export interface DocxTheme {
  name: DocxThemeName;
  label: string;
  /** Twips (1/20 pt): page margins + header/footer distance. */
  margins: { top: number; right: number; bottom: number; left: number; header: number; footer: number };
  /** Half-points for every size below (24 = 12pt). */
  body: { size: number; line: number; indentChars: number; after: number; jc: "both" | "left" };
  title: { size: number; color: string };
  heading1: { size: number; color: string; before: number; after: number; rule: boolean };
  heading2: { size: number; color: string };
  heading3: { size: number; color: string };
  table: { size: number };
  caption: { size: number; color: string };
  cover: { titleSize: number; subtitleSize: number; metaSize: number; spaceBefore: number };
  /** Accent used by cover rule, metric values and callout borders. */
  accent: string;
}

const BASE_THEME: Omit<DocxTheme, "name" | "label"> = {
  margins: { top: 1440, right: 1800, bottom: 1440, left: 1800, header: 851, footer: 992 },
  body: { size: 24, line: 360, indentChars: 200, after: 120, jc: "both" },
  title: { size: 40, color: "111827" },
  heading1: { size: 32, color: "1F2937", before: 360, after: 160, rule: true },
  heading2: { size: 28, color: "374151" },
  heading3: { size: 24, color: "374151" },
  table: { size: 21 },
  caption: { size: 19, color: "6B7280" },
  cover: { titleSize: 56, subtitleSize: 28, metaSize: 21, spaceBefore: 2400 },
  accent: "1F2937",
};

export const DOCX_THEMES: Record<DocxThemeName, DocxTheme> = {
  report: { ...BASE_THEME, name: "report", label: "报告/复盘" },
  proposal: {
    ...BASE_THEME,
    name: "proposal",
    label: "方案/计划",
    body: { ...BASE_THEME.body, size: 22, line: 340, indentChars: 200 },
    heading1: { ...BASE_THEME.heading1, size: 30 },
    accent: "1F4E79",
  },
  resume: {
    ...BASE_THEME,
    name: "resume",
    label: "简历",
    margins: { top: 1080, right: 1240, bottom: 1080, left: 1240, header: 720, footer: 720 },
    body: { size: 21, line: 300, indentChars: 0, after: 60, jc: "left" },
    title: { size: 36, color: "111827" },
    heading1: { size: 28, color: "111827", before: 260, after: 120, rule: true },
    heading2: { size: 24, color: "374151" },
    heading3: { size: 21, color: "4B5563" },
    table: { size: 19 },
    caption: { size: 17, color: "6B7280" },
    accent: "1F2937",
  },
  brief: {
    ...BASE_THEME,
    name: "brief",
    label: "通知/简报",
    body: { ...BASE_THEME.body, size: 22, indentChars: 0, jc: "left" },
    heading1: { ...BASE_THEME.heading1, size: 28, before: 300, after: 140 },
    accent: "1F2937",
  },
};

const MARGIN_PRESETS = {
  normal: { top: 1440, right: 1800, bottom: 1440, left: 1800, header: 851, footer: 992 },
  narrow: { top: 1080, right: 1080, bottom: 1080, left: 1080, header: 720, footer: 720 },
  wide: { top: 1800, right: 2160, bottom: 1800, left: 2160, header: 851, footer: 992 },
} as const;

export type DocxMarginPreset = keyof typeof MARGIN_PRESETS;

export function getDocxTheme(name: string | undefined, margins?: string): DocxTheme {
  const theme = DOCX_THEMES[(name ?? "report") as DocxThemeName] ?? DOCX_THEMES.report;
  if (margins && margins in MARGIN_PRESETS) {
    return { ...theme, margins: MARGIN_PRESETS[margins as DocxMarginPreset] };
  }
  return theme;
}

function pPrSpacing(line: number, before: number, after: number, rule = "auto"): string {
  return (
    '<w:spacing w:before="' + before + '" w:after="' + after + '" w:line="' + line + '" w:lineRule="' + rule + '"/>'
  );
}

/** Generates word/styles.xml for a theme. */
export function buildStylesXml(theme: DocxTheme): string {
  const bodyIndent =
    theme.body.indentChars > 0 ? '<w:ind w:firstLineChars="' + theme.body.indentChars + '"/>' : "";
  const rule = theme.heading1.rule
    ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="3" w:color="D9D9D9"/></w:pBdr>'
    : "";
  return (
    XML_DECL +
    '<w:styles xmlns:w="' + W_NS + '">' +
    "<w:docDefaults>" +
    "<w:rPrDefault><w:rPr>" +
    '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/>' +
    '<w:sz w:val="' + theme.body.size + '"/><w:szCs w:val="' + theme.body.size + '"/>' +
    '<w:lang w:val="en-US" w:eastAsia="zh-CN"/>' +
    "</w:rPr></w:rPrDefault>" +
    "<w:pPrDefault><w:pPr>" + pPrSpacing(theme.body.line, 0, 0) + "</w:pPr></w:pPrDefault>" +
    "</w:docDefaults>" +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
    '<w:name w:val="Normal"/><w:qFormat/>' +
    "<w:pPr>" + (theme.body.jc === "both" ? '<w:jc w:val="both"/>' : '<w:jc w:val="left"/>') +
    bodyIndent + pPrSpacing(theme.body.line, 0, theme.body.after) + "</w:pPr>" +
    '<w:rPr><w:sz w:val="' + theme.body.size + '"/><w:szCs w:val="' + theme.body.size + '"/></w:rPr>' +
    "</w:style>" +
    // title
    '<w:style w:type="paragraph" w:styleId="Title">' +
    '<w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="center"/><w:ind w:firstLineChars="0" w:firstLine="0"/>' +
    '<w:spacing w:before="120" w:after="280" w:line="240" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="黑体"/><w:color w:val="' + theme.title.color + '"/>' +
    '<w:b/><w:sz w:val="' + theme.title.size + '"/><w:szCs w:val="' + theme.title.size + '"/></w:rPr>' +
    "</w:style>" +
    headingStyle(theme, 1, "Heading1", theme.heading1.size, theme.heading1.color, theme.heading1.before, theme.heading1.after, rule) +
    headingStyle(theme, 2, "Heading2", theme.heading2.size, theme.heading2.color, 200, 100, "") +
    headingStyle(theme, 3, "Heading3", theme.heading3.size, theme.heading3.color, 160, 80, "") +
    // list
    '<w:style w:type="paragraph" w:styleId="ListParagraph">' +
    '<w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:ind w:left="440" w:hanging="220" w:firstLineChars="0" w:firstLine="0"/>' +
    pPrSpacing(theme.body.line, 0, 40) + "</w:pPr>" +
    '<w:rPr><w:sz w:val="' + theme.body.size + '"/></w:rPr>' +
    "</w:style>" +
    // quote
    '<w:style w:type="paragraph" w:styleId="Quote">' +
    '<w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:ind w:left="480" w:right="240" w:firstLineChars="0" w:firstLine="0"/>' +
    '<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="D9D9D9"/></w:pBdr>' +
    pPrSpacing(theme.body.line, 120, 120) + "</w:pPr>" +
    '<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="楷体"/><w:color w:val="4B5563"/><w:sz w:val="23"/></w:rPr>' +
    "</w:style>" +
    // caption
    '<w:style w:type="paragraph" w:styleId="Caption">' +
    '<w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="center"/><w:keepNext/><w:ind w:firstLineChars="0" w:firstLine="0"/>' +
    '<w:spacing w:before="60" w:after="120" w:line="240" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:color w:val="' + theme.caption.color + '"/><w:sz w:val="' + theme.caption.size + '"/><w:szCs w:val="' + theme.caption.size + '"/></w:rPr>' +
    "</w:style>" +
    // table text
    '<w:style w:type="paragraph" w:styleId="TableText">' +
    '<w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="left"/><w:ind w:firstLineChars="0" w:firstLine="0"/>' +
    '<w:spacing w:before="20" w:after="20" w:line="260" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:color w:val="1F2937"/><w:sz w:val="' + theme.table.size + '"/><w:szCs w:val="' + theme.table.size + '"/></w:rPr>' +
    "</w:style>" +
    // footer
    '<w:style w:type="paragraph" w:styleId="Footer">' +
    '<w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="center"/><w:ind w:firstLineChars="0" w:firstLine="0"/><w:spacing w:after="0"/></w:pPr>' +
    '<w:rPr><w:color w:val="808080"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>' +
    "</w:style>" +
    // cover
    '<w:style w:type="paragraph" w:styleId="CoverTitle">' +
    '<w:name w:val="Cover Title"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="center"/><w:ind w:firstLineChars="0" w:firstLine="0"/>' +
    '<w:spacing w:before="0" w:after="240" w:line="300" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="黑体"/><w:color w:val="111827"/>' +
    '<w:b/><w:sz w:val="' + theme.cover.titleSize + '"/><w:szCs w:val="' + theme.cover.titleSize + '"/></w:rPr>' +
    "</w:style>" +
    '<w:style w:type="paragraph" w:styleId="CoverSubtitle">' +
    '<w:name w:val="Cover Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="center"/><w:ind w:firstLineChars="0" w:firstLine="0"/>' +
    '<w:spacing w:before="0" w:after="160" w:line="300" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:color w:val="4B5563"/><w:sz w:val="' + theme.cover.subtitleSize + '"/><w:szCs w:val="' + theme.cover.subtitleSize + '"/></w:rPr>' +
    "</w:style>" +
    '<w:style w:type="paragraph" w:styleId="CoverMeta">' +
    '<w:name w:val="Cover Meta"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="center"/><w:ind w:firstLineChars="0" w:firstLine="0"/>' +
    '<w:spacing w:before="0" w:after="60" w:line="300" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:color w:val="6B7280"/><w:sz w:val="' + theme.cover.metaSize + '"/><w:szCs w:val="' + theme.cover.metaSize + '"/></w:rPr>' +
    "</w:style>" +
    // key/value module
    '<w:style w:type="paragraph" w:styleId="KvLabel">' +
    '<w:name w:val="KV Label"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="left"/><w:ind w:firstLineChars="0" w:firstLine="0"/><w:spacing w:before="20" w:after="20" w:line="260" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:color w:val="6B7280"/><w:sz w:val="' + Math.min(theme.body.size, 20) + '"/></w:rPr>' +
    "</w:style>" +
    '<w:style w:type="paragraph" w:styleId="KvValue">' +
    '<w:name w:val="KV Value"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="left"/><w:ind w:firstLineChars="0" w:firstLine="0"/><w:spacing w:before="20" w:after="20" w:line="260" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:color w:val="111827"/><w:sz w:val="' + theme.body.size + '"/></w:rPr>' +
    "</w:style>" +
    // metrics module
    '<w:style w:type="paragraph" w:styleId="MetricValue">' +
    '<w:name w:val="Metric Value"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="left"/><w:ind w:firstLineChars="0" w:firstLine="0"/><w:spacing w:before="40" w:after="20" w:line="300" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:color w:val="' + theme.accent + '"/>' +
    '<w:b/><w:sz w:val="' + (theme.body.size + 16) + '"/><w:szCs w:val="' + (theme.body.size + 16) + '"/></w:rPr>' +
    "</w:style>" +
    '<w:style w:type="paragraph" w:styleId="MetricLabel">' +
    '<w:name w:val="Metric Label"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="left"/><w:ind w:firstLineChars="0" w:firstLine="0"/><w:spacing w:before="0" w:after="40" w:line="240" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:color w:val="6B7280"/><w:sz w:val="18"/></w:rPr>' +
    "</w:style>" +
    '<w:style w:type="paragraph" w:styleId="MetricNote">' +
    '<w:name w:val="Metric Note"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="left"/><w:ind w:firstLineChars="0" w:firstLine="0"/><w:spacing w:before="0" w:after="40" w:line="240" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:color w:val="9CA3AF"/><w:sz w:val="16"/></w:rPr>' +
    "</w:style>" +
    // callout module
    '<w:style w:type="paragraph" w:styleId="CalloutTitle">' +
    '<w:name w:val="Callout Title"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="left"/><w:ind w:firstLineChars="0" w:firstLine="0"/><w:spacing w:before="40" w:after="40" w:line="280" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:color w:val="111827"/><w:b/><w:sz w:val="' + (theme.body.size - 1) + '"/></w:rPr>' +
    "</w:style>" +
    '<w:style w:type="paragraph" w:styleId="CalloutText">' +
    '<w:name w:val="Callout Text"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="left"/><w:ind w:firstLineChars="0" w:firstLine="0"/><w:spacing w:before="0" w:after="40" w:line="280" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:color w:val="374151"/><w:sz w:val="' + (theme.body.size - 2) + '"/></w:rPr>' +
    "</w:style>" +
    "</w:styles>"
  );
}

function headingStyle(
  theme: DocxTheme,
  level: 1 | 2 | 3,
  styleId: string,
  size: number,
  color: string,
  before: number,
  after: number,
  borderXml: string,
): string {
  return (
    '<w:style w:type="paragraph" w:styleId="' + styleId + '">' +
    '<w:name w:val="heading ' + level + '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:keepNext/><w:outlineLvl w:val="' + (level - 1) + '"/>' +
    '<w:ind w:firstLineChars="0" w:firstLine="0"/>' + borderXml +
    pPrSpacing(theme.body.line, before, after) + "</w:pPr>" +
    '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="黑体"/><w:color w:val="' + color + '"/>' +
    '<w:b/><w:sz w:val="' + size + '"/><w:szCs w:val="' + size + '"/></w:rPr>' +
    "</w:style>"
  );
}

/** Page setup (page-number footer included) for a theme. */
export interface SectPrOptions {
  /** Cover page: suppress the page number on the first page (titlePg + empty footer rId4). */
  firstPageFooter?: boolean;
}

export function sectPrFor(theme: DocxTheme, options: SectPrOptions = {}): string {
  const m = theme.margins;
  return (
    "<w:sectPr>" +
    (options.firstPageFooter ? '<w:footerReference w:type="first" r:id="rId4"/><w:titlePg/>' : "") +
    '<w:footerReference w:type="default" r:id="rId3"/>' +
    '<w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="' + m.top + '" w:right="' + m.right + '" w:bottom="' + m.bottom + '" w:left="' + m.left +
    '" w:header="' + m.header + '" w:footer="' + m.footer + '" w:gutter="0"/>' +
    "</w:sectPr>"
  );
}

/** Template-mode fallback: page setup without a footer part (the template owns footers). */
export const DEFAULT_SECT_PR =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/>' +
  "</w:sectPr>";

export const STANDARD_SECT_PR = sectPrFor(DOCX_THEMES.report);

/** Baseline (report) styles: kept for the manuscript exporter and legacy imports. */
export const STYLES_XML = buildStylesXml(DOCX_THEMES.report);

/** Bullet (numId 1) + decimal (numId 2) list definitions used by authored documents. */
export const NUMBERING_XML =
  XML_DECL +
  '<w:numbering xmlns:w="' + W_NS + '">' +
  '<w:abstractNum w:abstractNumId="0"><w:nsid w:val="1A2B3C4D"/><w:multiLevelType w:val="singleLevel"/>' +
  '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/>' +
  '<w:pPr><w:ind w:left="440" w:hanging="220"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr></w:lvl>' +
  "</w:abstractNum>" +
  '<w:abstractNum w:abstractNumId="1"><w:nsid w:val="2B3C4D5E"/><w:multiLevelType w:val="singleLevel"/>' +
  '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>' +
  '<w:pPr><w:ind w:left="440" w:hanging="220"/></w:pPr></w:lvl>' +
  "</w:abstractNum>" +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
  '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
  "</w:numbering>";

/** Centered "第 X 页 / 共 Y 页" footer (fields are updated by Word/LibreOffice on open). */
/** Empty footer used as the first-page footer so a cover page carries no page number. */
export const FOOTER_EMPTY_XML =
  XML_DECL +
  '<w:ftr xmlns:w="' + W_NS + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:p/></w:ftr>';

export const FOOTER_XML =
  XML_DECL +
  '<w:ftr xmlns:w="' + W_NS + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<w:p><w:pPr><w:pStyle w:val="Footer"/><w:jc w:val="center"/></w:pPr>' +
  '<w:r><w:t xml:space="preserve">第 </w:t></w:r>' +
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  '<w:r><w:t>1</w:t></w:r>' +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
  '<w:r><w:t xml:space="preserve"> 页 / 共 </w:t></w:r>' +
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  '<w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  '<w:r><w:t>1</w:t></w:r>' +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
  '<w:r><w:t xml:space="preserve"> 页</w:t></w:r>' +
  "</w:p></w:ftr>";

export const CONTENT_TYPES_XML =
  XML_DECL +
  '<Types xmlns="' + CT_NS + '">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
  '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
  '<Override PartName="/word/footer2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
  "</Types>";

export const PACKAGE_RELS_XML =
  XML_DECL +
  '<Relationships xmlns="' + RELS_NS + '">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

export const DOCUMENT_RELS_XML =
  XML_DECL +
  '<Relationships xmlns="' + RELS_NS + '">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' +
  '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer2.xml"/>' +
  "</Relationships>";

export const DOCUMENT_ROOT =
  '<w:document xmlns:w="' + W_NS + '"' +
  ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
  ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
  ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
  ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"' +
  ' xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"' +
  ' xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"' +
  ' xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"' +
  ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"' +
  ' mc:Ignorable="w14 w15">';

/** XML text escaping; invalid control characters are dropped so Word never sees a broken part. */
export function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\t/g, "    ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** One paragraph in the given style; text runs preserve leading/trailing spaces. */
export function paragraphXml(styleId: string, text: string): string {
  return (
    "<w:p><w:pPr>" +
    '<w:pStyle w:val="' + escapeXml(styleId) + '"/>' +
    "</w:pPr><w:r><w:t xml:space=\"preserve\">" +
    escapeXml(text) +
    "</w:t></w:r></w:p>"
  );
}

function sectionBodyXml(section: DocxSectionInput, styleIds: ResolvedStyleIds): string {
  const lines = (section.content ?? "").split(/\r?\n/);
  const parts = [paragraphXml(styleIds.heading1, section.title ?? "")];
  for (const line of lines) {
    if (line.length === 0) continue;
    parts.push(paragraphXml(styleIds.normal, line));
  }
  return parts.join("");
}

export interface ResolvedStyleIds {
  title: string;
  heading1: string;
  heading2: string;
  heading3: string;
  normal: string;
}

function normalizeStyleName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_\-]+/g, "");
}

export function parseStyleIds(stylesXml: string | undefined): Map<string, string> {
  const index = new Map<string, string>();
  if (!stylesXml) return index;
  for (const match of stylesXml.matchAll(/<w:style\b[^>]*>[\s\S]*?<\/w:style>/g)) {
    const block = match[0];
    const styleId = /\bw:styleId="([^"]+)"/.exec(block)?.[1];
    if (!styleId) continue;
    const type = /\bw:type="([^"]+)"/.exec(block)?.[1];
    if (type !== undefined && type !== "paragraph") continue;
    const name = /<w:name\b[^>]*\bw:val="([^"]*)"/.exec(block)?.[1];
    if (name) {
      const key = normalizeStyleName(name);
      if (!index.has(key)) index.set(key, styleId);
    }
    const idKey = normalizeStyleName(styleId);
    if (idKey && !index.has(idKey)) index.set(idKey, styleId);
  }
  return index;
}

export function resolveStyleIds(index: Map<string, string>): ResolvedStyleIds {
  const pick = (candidates: string[], fallback: string): string => {
    for (const candidate of candidates) {
      const found = index.get(normalizeStyleName(candidate));
      if (found) return found;
    }
    return fallback;
  };
  const heading1 = pick(["heading 1", "heading1", "标题 1", "标题1"], "Heading1");
  return {
    title: pick(["title", "标题", "document title"], heading1),
    heading1,
    heading2: pick(["heading 2", "heading2", "标题 2", "标题2"], "Heading2"),
    heading3: pick(["heading 3", "heading3", "标题 3", "标题3"], "Heading3"),
    normal: pick(["normal", "normal (web)", "正文"], "Normal"),
  };
}

export async function readZipText(zip: JSZip, path: string): Promise<string | undefined> {
  const entry = zip.file(path);
  return entry ? entry.async("string") : undefined;
}

export function extractSectPr(templateDocumentXml: string | undefined): string | undefined {
  if (!templateDocumentXml) return undefined;
  const matches = [...templateDocumentXml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)];
  return matches.length > 0 ? matches[matches.length - 1][0] : undefined;
}

export function extractDocumentRoot(templateDocumentXml: string | undefined): string {
  const root = templateDocumentXml ? /<w:document\b[^>]*>/.exec(templateDocumentXml)?.[0] : undefined;
  return root && root.includes("xmlns:w=") ? root : DOCUMENT_ROOT;
}

function documentXml(root: string, body: string, sectPr: string): string {
  return XML_DECL + root + "<w:body>" + body + sectPr + "</w:body></w:document>";
}

function standardBody(title: string | undefined, sections: DocxSectionInput[], styleIds: ResolvedStyleIds): string {
  const parts: string[] = [];
  if (title && title.trim().length > 0) parts.push(paragraphXml(styleIds.title, title.trim()));
  for (const section of sections) parts.push(sectionBodyXml(section, styleIds));
  return parts.join("");
}

const STANDARD_STYLE_IDS: ResolvedStyleIds = {
  title: "Title",
  heading1: "Heading1",
  heading2: "Heading2",
  heading3: "Heading3",
  normal: "Normal",
};

/**
 * Builds a .docx package from title + sections (academic manuscript path).
 * With a template only word/document.xml is regenerated.
 */
export async function buildDocxBuffer(options: BuildDocxOptions): Promise<Buffer> {
  const sections = options.sections ?? [];
  const title = options.title?.trim() ?? "";

  if (options.template && options.template.byteLength > 0) {
    const zip = await JSZip.loadAsync(options.template);
    const templateDocument = await readZipText(zip, "word/document.xml");
    const stylesXml = await readZipText(zip, "word/styles.xml");
    const styleIds = resolveStyleIds(parseStyleIds(stylesXml));
    const root = extractDocumentRoot(templateDocument);
    const sectPr = extractSectPr(templateDocument) ?? DEFAULT_SECT_PR;
    zip.file("word/document.xml", documentXml(root, standardBody(title, sections, styleIds), sectPr));
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  }

  const theme = DOCX_THEMES.report;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
  zip.file("_rels/.rels", PACKAGE_RELS_XML);
  zip.file(
    "word/document.xml",
    documentXml(DOCUMENT_ROOT, standardBody(title, sections, STANDARD_STYLE_IDS), sectPrFor(theme)),
  );
  zip.file("word/_rels/document.xml.rels", DOCUMENT_RELS_XML);
  zip.file("word/styles.xml", buildStylesXml(theme));
  zip.file("word/numbering.xml", NUMBERING_XML);
  zip.file("word/footer1.xml", FOOTER_XML);
  zip.file("word/footer2.xml", FOOTER_EMPTY_XML);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
