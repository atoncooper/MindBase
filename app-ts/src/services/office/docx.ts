import JSZip from "jszip";

import {
  CONTENT_TYPES_XML,
  DEFAULT_SECT_PR,
  DOCUMENT_RELS_XML,
  DOCUMENT_ROOT,
  FOOTER_EMPTY_XML,
  DOCX_THEMES,
  FOOTER_XML,
  NUMBERING_XML,
  PACKAGE_RELS_XML,
  XML_DECL,
  buildStylesXml,
  extractDocumentRoot,
  extractSectPr,
  getDocxTheme,
  parseStyleIds,
  readZipText,
  resolveStyleIds,
  sectPrFor,
  type DocxTheme,
  type ResolvedStyleIds,
} from "../docx-writer.js";
import { OfficeExportError } from "./errors.js";
import { clampText, parseInline, xmlEscape } from "./ooxml.js";
import { OFFICE_LIMITS, type DocxBlock, type InlineRun } from "./types.js";

/**
 * General-purpose Word builder: the layout model (cover / headings / paragraphs /
 * lines / lists / key-value grid / metrics / callout / table / quote / divider)
 * becomes OOXML.
 *
 * Design is driven by a THEME (docx-writer.ts): page margins, body size and
 * indent, heading hierarchy with a rule, neutral table chrome, caption and
 * module styles. The model picks a theme ("report" | "proposal" | "resume" |
 * "brief") and fills blocks; it never has to fake spacing with blank lines.
 *
 * Template mode keeps the user's package (styles/theme/headers/footers/page
 * setup survive); only word/document.xml is rewritten. Module blocks keep
 * explicit run formatting so they still look designed when the template has no
 * matching style ids, and list numbering falls back to glyph prefixes.
 */

export interface BuildDocxOptions {
  title?: string;
  blocks: DocxBlock[];
  /** Existing package whose styles/theme/headers/page setup must survive. */
  template?: Uint8Array;
  /** Layout theme name (report | proposal | resume | brief). */
  theme?: string;
  /** Page margin override (normal | narrow | wide). */
  margins?: string;
}

const BULLET_GLYPH = "•";
const TABLE_TOTAL_WIDTH = 8300; // A4 minus default margins, in twips

interface RunDefaults {
  size?: number;
  color?: string;
  italic?: boolean;
  bold?: boolean;
}

function runsXml(runs: InlineRun[], defaults: RunDefaults = {}): string {
  return runs
    .map((run) => {
      const props: string[] = [];
      if (run.code) {
        props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
        props.push('<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>');
      }
      if (run.bold || defaults.bold) props.push("<w:b/>");
      if (run.italic || defaults.italic) props.push("<w:i/>");
      if (run.code) {
        props.push('<w:color w:val="C7254E"/>');
      } else if (defaults.color) {
        props.push('<w:color w:val="' + defaults.color + '"/>');
      }
      if (defaults.size) {
        props.push('<w:sz w:val="' + defaults.size + '"/><w:szCs w:val="' + defaults.size + '"/>');
      }
      const text = xmlEscape(run.text).replace(/\n/g, '</w:t><w:br/><w:t xml:space="preserve">');
      const rPr = props.length > 0 ? "<w:rPr>" + props.join("") + "</w:rPr>" : "";
      return "<w:r>" + rPr + '<w:t xml:space="preserve">' + text + "</w:t></w:r>";
    })
    .join("");
}

interface ParaOptions extends RunDefaults {
  styleId: string;
  text?: string;
  runs?: InlineRun[];
  numId?: 1 | 2;
  indent?: { left?: number; hanging?: number };
  noIndent?: boolean;
  jc?: "center" | "both" | "left";
  keepNext?: boolean;
  spacingBefore?: number;
  spacingAfter?: number;
  borders?: string;
}

function paraXml(options: ParaOptions): string {
  const pPr: string[] = ['<w:pStyle w:val="' + xmlEscape(options.styleId) + '"/>'];
  if (options.numId !== undefined) {
    pPr.push('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="' + options.numId + '"/></w:numPr>');
  }
  const ind: string[] = [];
  if (options.noIndent) ind.push('w:firstLineChars="0" w:firstLine="0"');
  if (options.indent !== undefined) {
    ind.push('w:firstLineChars="0" w:firstLine="0"');
    if (options.indent.left !== undefined) ind.push('w:left="' + options.indent.left + '"');
    if (options.indent.hanging !== undefined) ind.push('w:hanging="' + options.indent.hanging + '"');
  }
  if (ind.length > 0) pPr.push("<w:ind " + ind.join(" ") + "/>");
  if (options.jc) pPr.push('<w:jc w:val="' + options.jc + '"/>');
  if (options.keepNext) pPr.push("<w:keepNext/>");
  if (options.borders) pPr.push(options.borders);
  if (options.spacingBefore !== undefined || options.spacingAfter !== undefined) {
    const before = options.spacingBefore !== undefined ? ' w:before="' + options.spacingBefore + '"' : "";
    const after = options.spacingAfter !== undefined ? ' w:after="' + options.spacingAfter + '"' : "";
    pPr.push("<w:spacing" + before + after + ' w:line="240" w:lineRule="auto"/>');
  }
  const runs = options.runs ?? (options.text !== undefined ? parseInline(options.text) : []);
  const body = runsXml(runs, options);
  return "<w:p><w:pPr>" + pPr.join("") + "</w:pPr>" + body + "</w:p>";
}

/** Empty paragraph used for vertical rhythm (cover page). */
function blankParagraph(before: number, after = 0): string {
  return (
    "<w:p><w:pPr>" +
    '<w:spacing w:before="' + before + '" w:after="' + after + '" w:line="240" w:lineRule="auto"/>' +
    "</w:pPr></w:p>"
  );
}

function paragraphRule(color: string, spacingBefore: number, spacingAfter: number): string {
  return (
    "<w:p><w:pPr>" +
    '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="' + color + '"/></w:pBdr>' +
    '<w:spacing w:before="' + spacingBefore + '" w:after="' + spacingAfter + '" w:line="240" w:lineRule="auto"/>' +
    "</w:pPr></w:p>"
  );
}

function pageBreakXml(): string {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function distributeWidths(widths: number[], total: number): number[] {
  const cleaned = widths.filter((w) => Number.isFinite(w) && w > 0);
  if (cleaned.length === 0) return [];
  const sum = cleaned.reduce((a, b) => a + b, 0);
  return cleaned.map((w) => Math.max(400, Math.round((w / sum) * total)));
}

/** Estimates data-table column widths from the longest cell (CJK counts double). */
function estimateWidths(block: Extract<DocxBlock, { type: "table" }>, columns: number): number[] {
  const weights = Array.from({ length: columns }, () => 6);
  const consider = (text: unknown, column: number): void => {
    if (column >= columns) return;
    const value = text === null || text === undefined ? "" : String(text);
    let width = 0;
    for (const ch of value) width += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
    weights[column] = Math.max(weights[column], Math.min(40, width + 2));
  };
  (block.headers ?? []).forEach((cell, index) => consider(cell, index));
  for (const row of block.rows.slice(0, 50)) row.forEach((cell, index) => consider(cell, index));
  return distributeWidths(weights, TABLE_TOTAL_WIDTH);
}

interface TableShellOptions {
  widths: number[];
  borders: string;
  rowsXml: string;
  cellMargins?: { top: number; bottom: number; left: number; right: number };
  rowHeightHeader?: boolean;
  align?: "center" | "left";
}

function tableShellXml(options: TableShellOptions): string {
  const margins = options.cellMargins ?? { top: 30, bottom: 30, left: 120, right: 120 };
  const tblPr =
    "<w:tblPr>" +
    '<w:tblW w:w="' + TABLE_TOTAL_WIDTH + '" w:type="dxa"/>' +
    '<w:jc w:val="' + (options.align ?? "center") + '"/>' +
    options.borders +
    '<w:tblLayout w:type="fixed"/>' +
    "<w:tblCellMar>" +
    '<w:top w:w="' + margins.top + '" w:type="dxa"/>' +
    '<w:left w:w="' + margins.left + '" w:type="dxa"/>' +
    '<w:bottom w:w="' + margins.bottom + '" w:type="dxa"/>' +
    '<w:right w:w="' + margins.right + '" w:type="dxa"/>' +
    "</w:tblCellMar>" +
    "</w:tblPr>";
  const grid = "<w:tblGrid>" + options.widths.map((w) => '<w:gridCol w:w="' + w + '"/>').join("") + "</w:tblGrid>";
  return "<w:tbl>" + tblPr + grid + options.rowsXml + "</w:tbl>";
}

function bordersAll(color: string, sides: string[]): string {
  return (
    "<w:tblBorders>" +
    sides.map((side) => '<w:' + side + ' w:val="single" w:sz="4" w:space="0" w:color="' + color + '"/>').join("") +
    "</w:tblBorders>"
  );
}

const NO_BORDERS =
  "<w:tblBorders>" +
  ["top", "left", "bottom", "right", "insideH", "insideV"]
    .map((side) => '<w:' + side + ' w:val="single" w:sz="4" w:space="0" w:color="FFFFFF"/>')
    .join("") +
  "</w:tblBorders>";

interface CellOptions {
  width: number;
  styleId: string;
  text?: string;
  runs?: InlineRun[];
  bold?: boolean;
  color?: string;
  size?: number;
  italic?: boolean;
  shading?: string;
  valign?: "center" | "top";
  borders?: { side: "left" | "right" | "top" | "bottom" | "insideH" | "insideV"; color: string; size?: number }[];
  rowSpan?: number;
  vMerge?: "restart" | "continue";
  paragraphs?: string[];
  margins?: { top: number; bottom: number; left: number; right: number };
}

function cellXml(options: CellOptions): string {
  const tcPr: string[] = ['<w:tcW w:w="' + options.width + '" w:type="dxa"/>'];
  if (options.shading) tcPr.push('<w:shd w:val="clear" w:color="auto" w:fill="' + options.shading + '"/>');
  if (options.rowSpan && options.rowSpan > 1) tcPr.push('<w:gridSpan w:val="' + options.rowSpan + '"/>');
  if (options.vMerge === "restart") tcPr.push('<w:vMerge w:val="restart"/>');
  if (options.vMerge === "continue") tcPr.push("<w:vMerge/>");
  if (options.borders && options.borders.length > 0) {
    // Explicit nil for every side the caller did not ask for: LibreOffice falls
    // back to a visible default border when a cell's tcBorders omit a side.
    const sides = ["top", "left", "bottom", "right", "insideH", "insideV"] as const;
    tcPr.push(
      "<w:tcBorders>" +
        sides
          .map((side) => {
            const border = options.borders?.find((entry) => entry.side === side);
            if (!border) return "<w:" + side + ' w:val="single" w:sz="4" w:space="0" w:color="FFFFFF"/>';
            return (
              "<w:" + side + ' w:val="single" w:sz="' + (border.size ?? 12) + '" w:space="0" w:color="' +
              border.color + '"/>'
            );
          })
          .join("") +
        "</w:tcBorders>",
    );
  }
  tcPr.push('<w:vAlign w:val="' + (options.valign ?? "center") + '"/>');
  const paragraphs =
    options.paragraphs ??
    [
      paraXml({
        styleId: options.styleId,
        ...(options.runs ? { runs: options.runs } : {}),
        ...(options.text !== undefined ? { text: options.text } : {}),
        ...(options.bold ? { bold: true } : {}),
        ...(options.italic ? { italic: true } : {}),
        ...(options.color ? { color: options.color } : {}),
        ...(options.size ? { size: options.size } : {}),
        noIndent: true,
        spacingBefore: 0,
        spacingAfter: 0,
      }),
    ];
  return "<w:tc><w:tcPr>" + tcPr.join("") + "</w:tcPr>" + paragraphs.join("") + "</w:tc>";
}

function tableRowXml(cells: string[], header = false): string {
  const trPr = header
    ? '<w:trPr><w:cantSplit/><w:tblHeader/><w:trHeight w:val="360" w:hRule="atLeast"/></w:trPr>'
    : "<w:trPr><w:cantSplit/></w:trPr>";
  return "<w:tr>" + trPr + cells.join("") + "</w:tr>";
}


/** Empty paragraph that visually separates stacked modules. */
function moduleSpacer(): string {
  return '<w:p><w:pPr><w:spacing w:before="0" w:after="140" w:line="240" w:lineRule="auto"/></w:pPr></w:p>';
}
function dataTableXml(block: Extract<DocxBlock, { type: "table" }>, styles: BuildStyles): string {
  const header = block.headers ?? [];
  const columns = Math.max(header.length, ...block.rows.map((row) => row.length), 1);
  const widths =
    block.widths && block.widths.length > 0
      ? distributeWidths(block.widths.slice(0, columns), TABLE_TOTAL_WIDTH)
      : estimateWidths(block, columns);
  const rows: string[] = [];
  if (header.length > 0) {
    rows.push(
      tableRowXml(
        widths.map((width, index) =>
          cellXml({
            width,
            styleId: styles.tableText,
            text: header[index] ?? "",
            shading: "F2F3F5",
            bold: true,
          }),
        ),
        true,
      ),
    );
  }
  for (const row of block.rows.slice(0, OFFICE_LIMITS.docxTableRows)) {
    rows.push(
      tableRowXml(
        widths.map((width, index) =>
          cellXml({ width, styleId: styles.tableText, text: row[index] === undefined ? "" : String(row[index]) }),
        ),
      ),
    );
  }
  const caption = block.caption?.trim()
    ? paraXml({
        styleId: styles.caption,
        text: block.caption.trim(),
        noIndent: true,
        jc: "center",
        keepNext: true,
        spacingBefore: 60,
        spacingAfter: 120,
      })
    : "";
  const spacer = paraXml({ styleId: styles.normal, text: "", noIndent: true, spacingAfter: 0 });
  return caption + tableShellXml({ widths, borders: bordersAll("D9D9D9", ["top", "left", "bottom", "right", "insideH", "insideV"]), rowsXml: rows.join("") }) + spacer;
}

function kvXml(block: Extract<DocxBlock, { type: "kv" }>, styles: BuildStyles, theme: DocxTheme): string {
  const columns = block.columns === 1 ? 1 : 2;
  const items = block.items.slice(0, 24);
  const rows: string[] = [];
  if (columns === 2) {
    const widths = distributeWidths([1500, 2600, 1500, 2600], TABLE_TOTAL_WIDTH);
    const cellWidths = widths.length === 4 ? widths : [1500, 2650, 1500, 2650];
    for (let index = 0; index < items.length; index += 2) {
      const left = items[index];
      const right = items[index + 1];
      const kvBorder = [{ side: "bottom" as const, color: "E5E7EB", size: 4 }];
      const cells = [
        cellXml({ width: cellWidths[0], styleId: styles.kvLabel, text: left?.label ?? "", color: "6B7280", size: 20, borders: kvBorder }),
        cellXml({ width: cellWidths[1], styleId: styles.kvValue, text: left?.value ?? "", color: "111827", size: theme.body.size, borders: kvBorder }),
        cellXml({ width: cellWidths[2], styleId: styles.kvLabel, text: right?.label ?? "", color: "6B7280", size: 20, borders: kvBorder }),
        cellXml({ width: cellWidths[3], styleId: styles.kvValue, text: right?.value ?? "", color: "111827", size: theme.body.size, borders: kvBorder }),
      ];
      rows.push("<w:tr><w:trPr><w:cantSplit/></w:trPr>" + cells.join("") + "</w:tr>");
    }
    return tableShellXml({ widths: cellWidths, borders: NO_BORDERS, rowsXml: rows.join(""), cellMargins: { top: 40, bottom: 40, left: 40, right: 120 } });
  }
  const widths = distributeWidths([1700, 6600], TABLE_TOTAL_WIDTH);
  for (const item of items) {
    rows.push(
      tableRowXml([
        cellXml({ width: widths[0], styleId: styles.kvLabel, text: item.label, color: "6B7280", size: 20, borders: [{ side: "bottom", color: "E5E7EB", size: 4 }] }),
        cellXml({ width: widths[1], styleId: styles.kvValue, text: item.value, color: "111827", size: theme.body.size, borders: [{ side: "bottom", color: "E5E7EB", size: 4 }] }),
      ]),
    );
  }
  return tableShellXml({ widths, borders: NO_BORDERS, rowsXml: rows.join(""), cellMargins: { top: 40, bottom: 40, left: 40, right: 120 } });
}

function metricsXml(block: Extract<DocxBlock, { type: "metrics" }>, styles: BuildStyles, theme: DocxTheme): string {
  const items = block.items.slice(0, 8);
  if (items.length === 0) return "";
  const columns = Math.min(items.length, 4);
  const widths = distributeWidths(Array.from({ length: columns }, () => 1), TABLE_TOTAL_WIDTH);
  const rows: string[] = [];
  for (let start = 0; start < items.length; start += columns) {
    const chunk = items.slice(start, start + columns);
    const cells = widths.map((width, index) => {
      const item = chunk[index];
      if (!item) return cellXml({ width, styleId: styles.normal, text: "" });
      const paragraphs = [
        paraXml({ styleId: styles.metricValue, text: item.value, noIndent: true, bold: true, color: theme.accent, size: theme.body.size + 16, spacingBefore: 40, spacingAfter: 20 }),
        paraXml({ styleId: styles.metricLabel, text: item.label, noIndent: true, color: "6B7280", size: 18, spacingBefore: 0, spacingAfter: item.note ? 0 : 40 }),
        ...(item.note
          ? [paraXml({ styleId: styles.metricNote, text: item.note, noIndent: true, color: "9CA3AF", size: 16, spacingBefore: 0, spacingAfter: 40 })]
          : []),
      ];
      return cellXml({ width, styleId: styles.normal, shading: "F7F8FA", paragraphs });
    });
    rows.push(tableRowXml(cells));
  }
  return tableShellXml({ widths, borders: NO_BORDERS, rowsXml: rows.join(""), cellMargins: { top: 80, bottom: 80, left: 140, right: 140 } });
}

function calloutXml(block: Extract<DocxBlock, { type: "callout" }>, styles: BuildStyles, theme: DocxTheme): string {
  const tone = block.tone === "warning" ? "warning" : block.tone === "success" ? "success" : "info";
  const palette =
    tone === "warning"
      ? { bg: "FFFBEB", accent: "D97706" }
      : tone === "success"
        ? { bg: "ECFDF5", accent: "059669" }
        : { bg: "EFF6FF", accent: "3B82F6" };
  const paragraphs = [
    ...(block.title
      ? [paraXml({ styleId: styles.calloutTitle, text: block.title, noIndent: true, bold: true, color: "111827", size: theme.body.size - 1, spacingBefore: 40, spacingAfter: 40 })]
      : []),
    paraXml({ styleId: styles.calloutText, text: block.text, noIndent: true, color: "374151", size: theme.body.size - 2, spacingBefore: 20, spacingAfter: 40 }),
  ];
  const cells = cellXml({
    width: TABLE_TOTAL_WIDTH,
    styleId: styles.normal,
    shading: palette.bg,
    paragraphs,
    borders: [{ side: "left", color: palette.accent, size: 24 }],
  });
  return tableShellXml({ widths: [TABLE_TOTAL_WIDTH], borders: NO_BORDERS, rowsXml: tableRowXml([cells]), cellMargins: { top: 120, bottom: 120, left: 200, right: 200 } });
}

interface BuildStyles extends ResolvedStyleIds {
  caption: string;
  tableText: string;
  listParagraph: string;
  quote: string;
  coverTitle: string;
  coverSubtitle: string;
  coverMeta: string;
  kvLabel: string;
  kvValue: string;
  metricValue: string;
  metricLabel: string;
  metricNote: string;
  calloutTitle: string;
  calloutText: string;
}

const STANDARD_BASE: ResolvedStyleIds = {
  title: "Title",
  heading1: "Heading1",
  heading2: "Heading2",
  heading3: "Heading3",
  normal: "Normal",
};

const STANDARD_STYLES: BuildStyles = {
  ...STANDARD_BASE,
  caption: "Caption",
  tableText: "TableText",
  listParagraph: "ListParagraph",
  quote: "Quote",
  coverTitle: "CoverTitle",
  coverSubtitle: "CoverSubtitle",
  coverMeta: "CoverMeta",
  kvLabel: "KvLabel",
  kvValue: "KvValue",
  metricValue: "MetricValue",
  metricLabel: "MetricLabel",
  metricNote: "MetricNote",
  calloutTitle: "CalloutTitle",
  calloutText: "CalloutText",
};

function templateStyles(base: ResolvedStyleIds): BuildStyles {
  return {
    ...base,
    caption: base.normal,
    tableText: base.normal,
    listParagraph: base.normal,
    quote: base.normal,
    coverTitle: base.title,
    coverSubtitle: base.normal,
    coverMeta: base.normal,
    kvLabel: base.normal,
    kvValue: base.normal,
    metricValue: base.normal,
    metricLabel: base.normal,
    metricNote: base.normal,
    calloutTitle: base.normal,
    calloutText: base.normal,
  };
}

function blockXml(block: DocxBlock, styles: BuildStyles, theme: DocxTheme, numbered: boolean): string {
  switch (block.type) {
    case "heading": {
      const level = block.level ?? 1;
      const styleId = level === 3 ? styles.heading3 : level === 2 ? styles.heading2 : styles.heading1;
      return paraXml({ styleId, text: block.text, noIndent: true, keepNext: true, jc: "left" });
    }
    case "paragraph":
      return paraXml({ styleId: styles.normal, text: block.text });
    case "line":
      return paraXml({ styleId: styles.normal, text: block.text, noIndent: true, spacingAfter: 60 });
    case "bullets": {
      const items = block.items.slice(0, 100);
      return items
        .map((item) =>
          numbered
            ? paraXml({
                styleId: styles.listParagraph,
                text: item,
                numId: block.ordered ? 2 : 1,
                indent: { left: 440, hanging: 220 },
              })
            : paraXml({
                styleId: styles.normal,
                runs: [{ text: (block.ordered ? "" : BULLET_GLYPH + " ") }, ...parseInline(item)],
                indent: { left: 480, hanging: 240 },
              }),
        )
        .join("");
    }
    case "quote":
      return paraXml({
        styleId: numbered ? styles.quote : styles.normal,
        text: block.text,
        noIndent: true,
        ...(numbered ? {} : { indent: { left: 480 }, color: "4B5563", italic: true }),
      });
    case "table":
      return dataTableXml(block, styles);
    case "kv":
      return kvXml(block, styles, theme) + moduleSpacer();
    case "metrics":
      return metricsXml(block, styles, theme) + moduleSpacer();
    case "callout":
      return calloutXml(block, styles, theme) + moduleSpacer();
    case "divider":
      return paragraphRule("D9D9D9", 160, 160);
    case "cover":
      return coverXml(block, styles, theme);
    case "pageBreak":
      return pageBreakXml();
    default:
      return "";
  }
}

function coverXml(block: Extract<DocxBlock, { type: "cover" }>, styles: BuildStyles, theme: DocxTheme): string {
  const parts: string[] = [blankParagraph(theme.cover.spaceBefore)];
  parts.push(paraXml({ styleId: styles.coverTitle, text: block.title, noIndent: true, jc: "center", bold: true, color: "111827", size: theme.cover.titleSize, spacingBefore: 0, spacingAfter: 240 }));
  if (block.subtitle) {
    parts.push(paraXml({ styleId: styles.coverSubtitle, text: block.subtitle, noIndent: true, jc: "center", color: "4B5563", size: theme.cover.subtitleSize, spacingBefore: 0, spacingAfter: 160 }));
  }
  for (const meta of block.meta ?? []) {
    parts.push(paraXml({ styleId: styles.coverMeta, text: meta, noIndent: true, jc: "center", color: "6B7280", size: theme.cover.metaSize, spacingBefore: 0, spacingAfter: 60 }));
  }
  parts.push(paragraphRule("D9D9D9", 240, 240));
  parts.push(pageBreakXml());
  return parts.join("");
}

function bodyXml(title: string | undefined, blocks: DocxBlock[], styles: BuildStyles, theme: DocxTheme, numbered: boolean): string {
  const parts: string[] = [];
  const hasCover = blocks.some((block) => block.type === "cover");
  const trimmed = title?.trim() ?? "";
  if (trimmed && !hasCover) {
    parts.push(paraXml({ styleId: styles.title, text: trimmed, noIndent: true, jc: "center" }));
  }
  for (const block of blocks.slice(0, OFFICE_LIMITS.docxBlocks)) parts.push(blockXml(block, styles, theme, numbered));
  return parts.join("");
}

/**
 * Builds the .docx package. With a template only word/document.xml is replaced:
 * styles, theme, headers/footers, numbering and page setup come from the user's
 * own file. Without a template the theme drives styles.xml + page margins.
 */
export async function buildDocxFromBlocks(options: BuildDocxOptions): Promise<Buffer> {
  const blocks = options.blocks ?? [];
  if (blocks.length === 0) throw new OfficeExportError("invalid", "Word 内容为空：至少需要一个段落或标题");
  const theme = getDocxTheme(options.theme, options.margins);

  if (options.template && options.template.byteLength > 0) {
    const zip = await JSZip.loadAsync(options.template);
    const templateDocument = await readZipText(zip, "word/document.xml");
    const stylesXml = await readZipText(zip, "word/styles.xml");
    const styles = templateStyles(resolveStyleIds(parseStyleIds(stylesXml)));
    const root = extractDocumentRoot(templateDocument);
    const sectPr = extractSectPr(templateDocument) ?? DEFAULT_SECT_PR;
    const body = bodyXml(options.title, blocks, styles, theme, false);
    zip.file("word/document.xml", XML_DECL + root + "<w:body>" + body + sectPr + "</w:body></w:document>");
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  }

  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
  zip.file("_rels/.rels", PACKAGE_RELS_XML);
  const hasCover = blocks.some((block) => block.type === "cover");
  zip.file(
    "word/document.xml",
    XML_DECL +
      DOCUMENT_ROOT +
      "<w:body>" +
      bodyXml(options.title, blocks, STANDARD_STYLES, theme, true) +
      sectPrFor(theme, { firstPageFooter: hasCover }) +
      "</w:body></w:document>",
  );
  zip.file("word/_rels/document.xml.rels", DOCUMENT_RELS_XML);
  zip.file("word/styles.xml", buildStylesXml(theme));
  zip.file("word/numbering.xml", NUMBERING_XML);
  zip.file("word/footer1.xml", FOOTER_XML);
  zip.file("word/footer2.xml", FOOTER_EMPTY_XML);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export { DOCX_THEMES };
