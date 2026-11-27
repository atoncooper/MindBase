import JSZip from "jszip";

import { OfficeExportError } from "./errors.js";
import { XML_DECL, cellRef, clampText, columnLetter, xmlEscape } from "./ooxml.js";
import { OFFICE_LIMITS, type SheetCell, type XlsxSheet } from "./types.js";

/**
 * Excel (.xlsx) workbook builder: sheets of cells with header styling, number
 * formats, formulas, frozen headers and autofilters.
 *
 * Hand-authored OOXML (jszip, like the docx writer) instead of a generator
 * dependency — app-ts runs from TypeScript with no bundler step and the
 * deployment image carries no office libraries.
 *
 * Strings are written as inline strings (t="inlineStr"), which avoids a
 * sharedStrings table entirely: one less part to keep in sync and no dedupe
 * bookkeeping for a document that is generated once and never appended to.
 *
 * Cell conventions (contract: docs/office-export.md):
 *  - number   -> numeric cell, formatted with thousands separators
 *  - boolean  -> t="b"
 *  - string starting with "=" -> formula (the "=" is stripped)
 *  - everything else -> text cell
 */

/** Style indices in xl/styles.xml (order must match STYLES_XML below). */
const STYLE = {
  default: 0,
  header: 1,
  text: 2,
  integer: 3,
  decimal: 4,
  percent: 5,
  total: 6,
  totalNumber: 7,
  title: 8,
  note: 9,
} as const;

const CONTENT_TYPES_XML = (sheetCount: number) =>
  XML_DECL +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  Array.from({ length: sheetCount }, (_, index) =>
    '<Override PartName="/xl/worksheets/sheet' + (index + 1) +
    '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
  ).join("") +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  "</Types>";

const PACKAGE_RELS_XML =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  "</Relationships>";

const STYLES_XML =
  XML_DECL +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="2">' +
  '<numFmt numFmtId="164" formatCode="#,##0.00"/>' +
  '<numFmt numFmtId="165" formatCode="0%"/>' +
  "</numFmts>" +
  '<fonts count="5">' +
  '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><charset val="134"/></font>' +
  '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><charset val="134"/></font>' +
  '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/><charset val="134"/></font>' +
  '<font><b/><sz val="14"/><color rgb="FF1F2937"/><name val="Calibri"/><family val="2"/><charset val="134"/></font>' +
  '<font><sz val="10"/><color rgb="FF6B7280"/><name val="Calibri"/><family val="2"/><charset val="134"/><i/></font>' +
  "</fonts>" +
  '<fills count="4">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/><bgColor indexed="64"/></patternFill></fill>' +
  "</fills>" +
  '<borders count="2">' +
  "<border><left/><right/><top/><bottom/><diagonal/></border>" +
  '<border><left style="thin"><color rgb="FFD9D9D9"/></left><right style="thin"><color rgb="FFD9D9D9"/></right>' +
  '<top style="thin"><color rgb="FFD9D9D9"/></top><bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border>' +
  "</borders>" +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="10">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1">' +
  '<alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">' +
  '<alignment vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">' +
  '<alignment horizontal="right" vertical="center"/></xf>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">' +
  '<alignment horizontal="right" vertical="center"/></xf>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">' +
  '<alignment horizontal="right" vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +
  '<xf numFmtId="3" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
  '<alignment horizontal="right" vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">' +
  '<alignment vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">' +
  '<alignment vertical="center"/></xf>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

/** Sheet names: Excel forbids []:*?/\ and caps at 31 chars; duplicates get a suffix. */
function sheetName(name: string, index: number, used: Set<string>): string {
  const base = (name || "Sheet" + (index + 1)).replace(/[\[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet" + (index + 1);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    const tail = " (" + suffix + ")";
    candidate = base.slice(0, 31 - tail.length) + tail;
    suffix += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function stringCell(ref: string, style: number, text: string): string {
  return (
    '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' +
    xmlEscape(clampText(text)) +
    "</t></is></c>"
  );
}

function numberCell(ref: string, value: number): string {
  const style = Number.isInteger(value) ? STYLE.integer : STYLE.decimal;
  return '<c r="' + ref + '" s="' + style + '"><v>' + value + "</v></c>";
}

/** One cell; style is decided by the value type so headers/totals stay overridable. */
function cellXml(ref: string, value: SheetCell, style: number): string {
  if (value === null || value === undefined || value === "") {
    return '<c r="' + ref + '" s="' + style + '"/>';
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return numberCell(ref, value);
  }
  if (typeof value === "boolean") {
    return '<c r="' + ref + '" s="' + style + '" t="b"><v>' + (value ? 1 : 0) + "</v></c>";
  }
  const text = String(value);
  if (text.startsWith("=") && text.length > 1) {
    const formula = xmlEscape(text.slice(1));
    return '<c r="' + ref + '" s="' + style + '"><f>' + formula + "</f></c>";
  }
  return stringCell(ref, style, text);
}

/** Approximate column width from the widest cell (Excel width units, clamped). */
function estimateWidths(sheet: XlsxSheet, columns: number): number[] {
  const sizes = Array.from({ length: columns }, (_, index) => {
    let max = 0;
    const consider = (value: SheetCell | undefined) => {
      if (value === null || value === undefined) return;
      const text = String(value);
      // CJK glyphs are roughly twice as wide as Latin ones.
      const width = [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
      if (width > max) max = width;
    };
    (sheet.headers ?? []).forEach((header, col) => {
      if (col === index) consider(header);
    });
    for (const row of sheet.rows) consider(row[index]);
    return max;
  });
  return sizes.map((size) => Math.min(60, Math.max(10, size + 2)));
}

function sheetXml(sheet: XlsxSheet): string {
  const headers = sheet.headers ?? [];
  const columns = Math.max(headers.length, ...sheet.rows.map((row) => row.length), 1);
  if (columns > OFFICE_LIMITS.xlsxCols) {
    throw new OfficeExportError("invalid", "工作表「" + sheet.name + "」列数超过 " + OFFICE_LIMITS.xlsxCols + " 列上限");
  }
  const rows = sheet.rows.slice(0, OFFICE_LIMITS.xlsxRows);
  const widths =
    sheet.widths && sheet.widths.length > 0
      ? Array.from({ length: columns }, (_, index) => Math.min(80, Math.max(8, sheet.widths?.[index] ?? 14)))
      : estimateWidths(sheet, columns);

  const rowXml: string[] = [];
  let rowIndex = 1;
  const merges: string[] = [];

  if (sheet.title?.trim()) {
    rowXml.push(
      '<row r="1" ht="26" customHeight="1">' +
        stringCell(cellRef(0, 0), STYLE.title, sheet.title.trim()) +
        "</row>",
    );
    if (columns > 1) merges.push("A1:" + columnLetter(columns - 1) + "1");
    rowIndex = 2;
  }

  const headerRowIndex = rowIndex;
  if (headers.length > 0) {
    const cells = headers
      .map((header, index) => stringCell(cellRef(rowIndex - 1, index), STYLE.header, header))
      .join("");
    rowXml.push('<row r="' + rowIndex + '" ht="22" customHeight="1">' + cells + "</row>");
    rowIndex += 1;
  }

  const firstDataRow = rowIndex;
  rows.forEach((row, index) => {
    const isTotal = sheet.totalRow === true && index === rows.length - 1 && rows.length > 1;
    const cells = Array.from({ length: columns }, (_, col) => {
      const ref = cellRef(rowIndex - 1, col);
      const value = row[col] ?? null;
      if (isTotal) {
        const style = typeof value === "number" ? STYLE.totalNumber : STYLE.total;
        return cellXml(ref, value, style);
      }
      // Body cells keep their value type; empty cells inherit the text border.
      return cellXml(ref, value, STYLE.text);
    }).join("");
    rowXml.push('<row r="' + rowIndex + '">' + cells + "</row>");
    rowIndex += 1;
  });

  const lastDataRow = rowIndex - 1;
  const lastCol = columnLetter(columns - 1);
  const freezeAt = headerRowIndex;
  const freezeRows = sheet.freezeHeader !== false && headers.length > 0 ? freezeAt : 0;
  const sheetView =
    '<sheetViews><sheetView tabSelected="1" workbookViewId="0">' +
    (freezeRows > 0
      ? '<pane ySplit="' + freezeRows + '" topLeftCell="A' + (freezeRows + 1) +
        '" activePane="bottomLeft" state="frozen"/>' +
        '<selection pane="bottomLeft" activeCell="A' + (freezeRows + 1) + '" sqref="A' + (freezeRows + 1) + '"/>'
      : "") +
    "</sheetView></sheetViews>";

  const cols =
    '<cols>' +
    widths
      .map((width, index) => '<col min="' + (index + 1) + '" max="' + (index + 1) + '" width="' + width + '" customWidth="1"/>')
      .join("") +
    "</cols>";

  const autoFilter =
    sheet.autoFilter !== false && headers.length > 0 && rows.length > 0
      ? '<autoFilter ref="A' + headerRowIndex + ":" + lastCol + lastDataRow + '"/>'
      : "";
  const mergeCells =
    merges.length > 0
      ? '<mergeCells count="' + merges.length + '">' +
        merges.map((ref) => '<mergeCell ref="' + ref + '"/>').join("") +
        "</mergeCells>"
      : "";

  return (
    XML_DECL +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<dimension ref="A1:' + lastCol + Math.max(lastDataRow, 1) + '"/>' +
    sheetView +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    cols +
    "<sheetData>" + rowXml.join("") + "</sheetData>" +
    autoFilter +
    mergeCells +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    "</worksheet>"
  );
}

function workbookXml(names: string[]): string {
  return (
    XML_DECL +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<workbookPr/>' +
    "<sheets>" +
    names
      .map(
        (name, index) =>
          '<sheet name="' + xmlEscape(name) + '" sheetId="' + (index + 1) + '" r:id="rId' + (index + 1) + '"/>',
      )
      .join("") +
    "</sheets>" +
    "</workbook>"
  );
}

function workbookRelsXml(sheetCount: number): string {
  return (
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    Array.from({ length: sheetCount }, (_, index) =>
      '<Relationship Id="rId' + (index + 1) +
      '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' +
      (index + 1) + '.xml"/>',
    ).join("") +
    '<Relationship Id="rId' + (sheetCount + 1) +
    '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    "</Relationships>"
  );
}

function coreXml(title: string, now: Date): string {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    XML_DECL +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
    ' xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    "<dc:title>" + xmlEscape(title) + "</dc:title>" +
    "<dc:creator>MindBase</dc:creator>" +
    "<cp:lastModifiedBy>MindBase</cp:lastModifiedBy>" +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + iso + "</dcterms:created>" +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + iso + "</dcterms:modified>" +
    "</cp:coreProperties>"
  );
}

const APP_XML =
  XML_DECL +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"' +
  ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  "<Application>MindBase</Application>" +
  "</Properties>";

/** Builds a complete .xlsx package from the sheet specs. */
export async function buildXlsx(options: { title: string; sheets: XlsxSheet[]; now?: Date }): Promise<Buffer> {
  const sheets = options.sheets ?? [];
  if (sheets.length === 0) throw new OfficeExportError("invalid", "Excel 内容为空：至少需要一个工作表");
  if (sheets.length > OFFICE_LIMITS.xlsxSheets) {
    throw new OfficeExportError("invalid", "工作表数量超过 " + OFFICE_LIMITS.xlsxSheets + " 个上限");
  }
  const used = new Set<string>();
  const names = sheets.map((sheet, index) => sheetName(sheet.name, index, used));

  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML(sheets.length));
  zip.file("_rels/.rels", PACKAGE_RELS_XML);
  zip.file("xl/workbook.xml", workbookXml(names));
  zip.file("xl/_rels/workbook.xml.rels", workbookRelsXml(sheets.length));
  zip.file("xl/styles.xml", STYLES_XML);
  sheets.forEach((sheet, index) => {
    zip.file("xl/worksheets/sheet" + (index + 1) + ".xml", sheetXml(sheet));
  });
  zip.file("docProps/core.xml", coreXml(options.title, options.now ?? new Date()));
  zip.file("docProps/app.xml", APP_XML);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
