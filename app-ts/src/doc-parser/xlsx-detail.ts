import JSZip from "jszip";

/**
 * Excel (.xlsx) DETAIL projection: sheet order/names, used range, header row,
 * row preview, formulas, merged cells, frozen pane, auto filter and column
 * widths.
 *
 * Layer: doc-parser (format knowledge only - no HTTP, no repositories, no LLM).
 * It complements the plain-text import path: an agent that has to understand or
 * reproduce a workbook needs the sheet structure (names + order from
 * xl/workbook.xml), the used range, the header row, a bounded row preview, the
 * formula list and the layout hints (merges / frozen pane / filter / widths),
 * not a flattened CSV dump.
 *
 * Why hand-written scanning: the same trade-off as ./docx-detail.ts - no XML
 * dependency is added, DTD / custom entities are never expanded (only the five
 * predefined entities and numeric character references are decoded), and every
 * part is read through zip-bomb guards (entry count, per-entry and total
 * uncompressed size, XML node/part caps) before it is trusted.
 *
 * Contract: a pure function over a Buffer. Failures (empty/oversized file,
 * corrupt zip, missing workbook) throw XlsxDetailError with a Chinese reason so
 * the caller can hand it to the model. No I/O, no global state.
 *
 * Semantics worth knowing:
 *  - rowCount / colCount describe the used range: the worksheet dimension when
 *    the file declares one, otherwise the extents of the cells that actually
 *    carry text (a synthesized A1:C3-style dimension is reported then).
 *  - headers is the first previewed data row; rows are the previewed rows after
 *    it. Header + rows together are capped by maxRows (default 20, hard 100).
 *  - Formulas are reported for the whole sheet (bounded by maxFormulas) even
 *    when the preview only shows the first rows.
 */

/** File-size ceiling for one .xlsx (same product class as Word import). */
export const MAX_XLSX_BYTES = 20 * 1024 * 1024;
/** Uncompressed ceiling for ONE zip entry (zip-bomb guard). */
export const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;
/** Entry-count ceiling: a real workbook has far fewer parts. */
export const MAX_ZIP_ENTRIES = 1000;
/** Total uncompressed ceiling for the whole package. */
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

export const DEFAULT_MAX_ROWS = 20;
export const HARD_MAX_ROWS = 100;
export const DEFAULT_MAX_SHEETS = 20;
export const HARD_MAX_SHEETS = 50;
export const DEFAULT_MAX_FORMULAS = 50;
export const HARD_MAX_FORMULAS = 200;

const MAX_XML_PART_CHARS = 16 * 1024 * 1024;
const MAX_XML_NODES = 400_000;
const MAX_CELL_CHARS = 200;
const MAX_PREVIEW_COLS = 30;
const MAX_MERGED_CELLS = 100;
const MAX_COLUMN_WIDTHS = 100;

export const DEFAULT_SUMMARY_CHARS = 6000;

export interface XlsxSheetDetail {
  name: string;
  /** Declared or synthesized used range, e.g. A1:D20. */
  dimension?: string;
  rowCount: number;
  colCount: number;
  /** First previewed data row (column-aligned), when the sheet has data. */
  headers?: string[];
  /** Remaining previewed rows (header excluded). */
  rows: string[][];
  formulas: Array<{ cell: string; formula: string }>;
  merged: string[];
  /** Column widths in character units, index 0 = column A (bounded). */
  columnWidths?: number[];
  /** Frozen pane start cell, e.g. B3. */
  freezePane?: string;
  /** Auto filter range, e.g. A1:D10. */
  autoFilter?: string;
}

export interface XlsxDetail {
  /** Total worksheet count in the workbook (may exceed sheets.length when capped). */
  sheetCount: number;
  sheets: XlsxSheetDetail[];
}

export interface XlsxParseOptions {
  /** Preview rows (header included), default 20, hard cap 100. */
  maxRows?: number;
  /** Worksheets parsed, default 20, hard cap 50. */
  maxSheets?: number;
  /** Formulas kept per sheet, default 50, hard cap 200. */
  maxFormulas?: number;
}

export interface XlsxRenderOptions {
  /** Character budget, default 6000 (hard max 60000). */
  maxChars?: number;
}

/** User-facing parse failure: the message is already a Chinese explanation. */
export class XlsxDetailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XlsxDetailError";
  }
}

// ---------------------------------------------------------------------------
// Minimal OOXML scanner (same style as ./docx-detail.ts)
// ---------------------------------------------------------------------------

const TEXT_NODE = "#text";

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decodes only the predefined entities and numeric character references; an
 * unknown entity stays literal (custom entities from a DTD are never expanded).
 */
function decodeXmlText(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (match: string, body: string) => {
    if (body.charAt(0) === "#") {
      const hex = body.charAt(1) === "x" || body.charAt(1) === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

function isNameChar(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_" ||
    ch === "-" ||
    ch === "." ||
    ch === ":"
  );
}

/**
 * Builds a light element tree. Comments / processing instructions / DOCTYPE /
 * CDATA are consumed but never expanded; malformed nesting is tolerated by
 * popping to the matching open tag. Node count is capped so a pathological part
 * cannot exhaust memory.
 */
function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let nodes = 0;
  let i = 0;

  const appendText = (raw: string): void => {
    if (raw.length === 0) return;
    const parent = stack[stack.length - 1];
    parent.children.push({ name: TEXT_NODE, attrs: {}, children: [], text: decodeXmlText(raw) });
    nodes += 1;
  };

  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      appendText(xml.slice(i));
      break;
    }
    if (lt > i) appendText(xml.slice(i, lt));
    i = lt;

    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9);
      if (end < 0) break;
      // Raw character data: never entity-decoded.
      const parent = stack[stack.length - 1];
      parent.children.push({ name: TEXT_NODE, attrs: {}, children: [], text: xml.slice(i + 9, end) });
      nodes += 1;
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<!", i)) {
      // DOCTYPE and friends: skipped, never expanded.
      const end = xml.indexOf(">", i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (xml.startsWith("</", i)) {
      let nameEnd = i + 2;
      while (nameEnd < xml.length && isNameChar(xml.charAt(nameEnd))) nameEnd += 1;
      const name = xml.slice(i + 2, nameEnd);
      const end = xml.indexOf(">", nameEnd);
      i = end < 0 ? xml.length : end + 1;
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].name === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    // Start tag.
    let p = i + 1;
    const nameStart = p;
    while (p < xml.length && isNameChar(xml.charAt(p))) p += 1;
    const name = xml.slice(nameStart, p);
    if (name.length === 0) {
      i += 1;
      continue;
    }
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    while (p < xml.length) {
      while (p < xml.length && /\s/.test(xml.charAt(p))) p += 1;
      if (p >= xml.length) break;
      if (xml.charAt(p) === ">") {
        p += 1;
        break;
      }
      if (xml.charAt(p) === "/" && xml.charAt(p + 1) === ">") {
        selfClosing = true;
        p += 2;
        break;
      }
      const attrStart = p;
      while (p < xml.length && isNameChar(xml.charAt(p))) p += 1;
      const attrName = xml.slice(attrStart, p);
      if (attrName.length === 0) {
        p += 1;
        continue;
      }
      while (p < xml.length && /\s/.test(xml.charAt(p))) p += 1;
      if (xml.charAt(p) !== "=") {
        attrs[attrName] = "";
        continue;
      }
      p += 1;
      while (p < xml.length && /\s/.test(xml.charAt(p))) p += 1;
      const quote = xml.charAt(p);
      if (quote === '"' || quote === "'") {
        const valueEnd = xml.indexOf(quote, p + 1);
        if (valueEnd < 0) {
          attrs[attrName] = decodeXmlText(xml.slice(p + 1));
          p = xml.length;
          break;
        }
        attrs[attrName] = decodeXmlText(xml.slice(p + 1, valueEnd));
        p = valueEnd + 1;
      } else {
        const valueStart = p;
        while (p < xml.length && !/[\s>]/.test(xml.charAt(p))) p += 1;
        attrs[attrName] = decodeXmlText(xml.slice(valueStart, p));
      }
    }
    i = p;

    const node: XmlNode = { name, attrs, children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    nodes += 1;
    if (nodes > MAX_XML_NODES) {
      throw new XlsxDetailError("Excel 文档结构过大（XML 节点数超过上限），无法完整解析");
    }
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function isElement(node: XmlNode): boolean {
  return node.name !== TEXT_NODE && node.name !== "#root";
}

function childElements(node: XmlNode | undefined, name?: string): XmlNode[] {
  if (!node) return [];
  const out: XmlNode[] = [];
  for (const child of node.children) {
    if (!isElement(child)) continue;
    if (name === undefined || child.name === name) out.push(child);
  }
  return out;
}

function firstChild(node: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined;
  for (const child of node.children) {
    if (child.name === name) return child;
  }
  return undefined;
}

function firstDescendant(node: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined;
  for (const child of node.children) {
    if (child.name === name) return child;
    const nested = firstDescendant(child, name);
    if (nested) return nested;
  }
  return undefined;
}

/** Depth-first descendants in document order (bounded by the scanner node cap). */
function descendants(node: XmlNode | undefined, name: string): XmlNode[] {
  if (!node) return [];
  const out: XmlNode[] = [];
  const visit = (current: XmlNode): void => {
    for (const child of current.children) {
      if (!isElement(child)) continue;
      if (child.name === name) out.push(child);
      visit(child);
    }
  };
  visit(node);
  return out;
}

function nodeText(node: XmlNode): string {
  if (node.name === TEXT_NODE) return node.text;
  let out = "";
  for (const child of node.children) out += nodeText(child);
  return out;
}

function attr(node: XmlNode | undefined, name: string): string | undefined {
  if (!node) return undefined;
  const value = node.attrs[name];
  return value === undefined ? undefined : value;
}

function textAttr(node: XmlNode | undefined, name: string): string | undefined {
  const value = attr(node, name);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numAttr(node: XmlNode | undefined, name: string): number | undefined {
  const value = textAttr(node, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampInt(value: number | undefined, fallback: number, hardMax: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (rounded < 0) return 0;
  return rounded > hardMax ? hardMax : rounded;
}

function clipText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + "…" : value;
}

// ---------------------------------------------------------------------------
// Package access (zip-bomb guarded)
// ---------------------------------------------------------------------------

function entryUncompressedSize(file: JSZip.JSZipObject): number | undefined {
  const data = (file as unknown as { _data?: { uncompressedSize?: number } })._data;
  const size = data?.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) ? size : undefined;
}

/** Every entry is checked before anything is decompressed. */
function assertNoZipBomb(zip: JSZip): void {
  const names = Object.keys(zip.files);
  if (names.length > MAX_ZIP_ENTRIES) {
    throw new XlsxDetailError("Excel 包内部件过多（超过 " + MAX_ZIP_ENTRIES + " 个），已拒绝解析");
  }
  let total = 0;
  for (const name of names) {
    const file = zip.file(name);
    if (!file || file.dir) continue;
    const size = entryUncompressedSize(file);
    if (size === undefined) continue;
    if (size > MAX_ZIP_ENTRY_BYTES) {
      throw new XlsxDetailError(
        "Excel 包内单个部件解压后超过 " + Math.round(MAX_ZIP_ENTRY_BYTES / 1024 / 1024) + "MB（疑似压缩炸弹），已拒绝解析",
      );
    }
    total += size;
    if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new XlsxDetailError("Excel 包解压后总大小超过上限（疑似压缩炸弹），已拒绝解析");
    }
  }
}

async function readTextPart(zip: JSZip, path: string): Promise<string | undefined> {
  const file = zip.file(path);
  if (!file || file.dir) return undefined;
  const declared = entryUncompressedSize(file);
  if (declared !== undefined && declared > MAX_ZIP_ENTRY_BYTES) {
    throw new XlsxDetailError("Excel 包内的 " + path + " 解压后过大，已跳过");
  }
  const data = await file.async("uint8array");
  if (data.byteLength > MAX_ZIP_ENTRY_BYTES) {
    throw new XlsxDetailError("Excel 包内的 " + path + " 解压后过大，已跳过");
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  if (text.length > MAX_XML_PART_CHARS) {
    throw new XlsxDetailError("Excel 包内的 " + path + " 超过解析上限（16MB 文本）");
  }
  return text;
}

/** Relationship id -> resolved package path for one .rels part (missing rels = empty map). */
async function readRelationships(zip: JSZip, relsPath: string, baseDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const text = await readTextPart(zip, relsPath);
  if (text === undefined) return map;
  const root = parseXml(text);
  for (const rel of descendants(root, "Relationship")) {
    const id = textAttr(rel, "Id");
    const target = textAttr(rel, "Target");
    if (!id || !target) continue;
    map.set(id, resolveTarget(baseDir, target));
  }
  return map;
}

function resolveTarget(baseDir: string, target: string): string {
  let value = target.replace(/\\/g, "/");
  if (value.startsWith("/")) return value.slice(1);
  while (value.startsWith("./")) value = value.slice(2);
  if (value.startsWith("../")) {
    const parts = baseDir.split("/").filter((part) => part.length > 0);
    let rest = value;
    while (rest.startsWith("../") && parts.length > 0) {
      parts.pop();
      rest = rest.slice(3);
    }
    return parts.length > 0 ? parts.join("/") + "/" + rest : rest;
  }
  return baseDir.length > 0 ? baseDir + "/" + value : value;
}

// ---------------------------------------------------------------------------
// Cell references / values
// ---------------------------------------------------------------------------

interface CellRef {
  col: number;
  row: number;
}

function parseCellRef(ref: string | undefined): CellRef | undefined {
  if (ref === undefined) return undefined;
  const match = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref.trim());
  if (!match) return undefined;
  const letters = match[1].toUpperCase();
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(match[2]);
  if (!Number.isFinite(row) || row <= 0 || col <= 0) return undefined;
  return { col, row };
}

function columnLetter(index: number): string {
  let value = Math.trunc(index);
  let out = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out.length > 0 ? out : "A";
}

interface CellRange {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

function parseRange(ref: string | undefined): CellRange | undefined {
  if (ref === undefined) return undefined;
  const parts = ref.split(":");
  const start = parseCellRef(parts[0]);
  const end = parseCellRef(parts[1] ?? parts[0]);
  if (!start || !end) return undefined;
  return {
    startCol: Math.min(start.col, end.col),
    startRow: Math.min(start.row, end.row),
    endCol: Math.max(start.col, end.col),
    endRow: Math.max(start.row, end.row),
  };
}

/** Concatenated visible text of a shared-string / inline-string container (phonetic runs skipped). */
function richText(node: XmlNode): string {
  let out = "";
  const visit = (current: XmlNode): void => {
    for (const child of current.children) {
      if (child.name === "rPh") continue;
      if (child.name === TEXT_NODE) {
        out += child.text;
        continue;
      }
      if (child.name === "t") {
        out += nodeText(child);
        continue;
      }
      visit(child);
    }
  };
  visit(node);
  return out.replace(/\r/g, "").trim();
}

function cellText(cell: XmlNode, shared: string[]): string {
  const type = textAttr(cell, "t");
  if (type === "inlineStr") {
    const inline = firstChild(cell, "is");
    return inline ? richText(inline) : "";
  }
  const valueNode = firstChild(cell, "v");
  const raw = valueNode ? nodeText(valueNode).trim() : "";
  if (raw.length === 0) return "";
  if (type === "s") {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= shared.length) return "";
    return shared[index];
  }
  if (type === "b") {
    if (raw === "1" || raw.toLowerCase() === "true") return "TRUE";
    if (raw === "0" || raw.toLowerCase() === "false") return "FALSE";
    return raw;
  }
  return raw;
}

/**
 * Formula text of one cell. Shared formulas carry no text on the dependent
 * cells, so the first formula text seen for a shared-formula index is reused.
 */
function cellFormula(cell: XmlNode, sharedFormulas: Map<string, string>): string | undefined {
  const formulaNode = firstChild(cell, "f");
  if (!formulaNode) return undefined;
  const text = nodeText(formulaNode).trim();
  const kind = textAttr(formulaNode, "t");
  const sharedIndex = textAttr(formulaNode, "si");
  if (text.length > 0) {
    if (kind === "shared" && sharedIndex !== undefined) sharedFormulas.set(sharedIndex, text);
    return text;
  }
  if (sharedIndex !== undefined) return sharedFormulas.get(sharedIndex);
  return undefined;
}

function parseSharedStrings(root: XmlNode): string[] {
  return descendants(root, "si").map((item) => richText(item));
}

function parseMergedCells(root: XmlNode): string[] {
  const merged: string[] = [];
  for (const mergeCell of descendants(root, "mergeCell")) {
    if (merged.length >= MAX_MERGED_CELLS) break;
    const ref = textAttr(mergeCell, "ref");
    if (ref !== undefined) merged.push(ref);
  }
  return merged;
}

function parseFreezePane(root: XmlNode): string | undefined {
  const pane = firstDescendant(root, "pane");
  if (!pane) return undefined;
  const topLeft = textAttr(pane, "topLeftCell");
  if (topLeft !== undefined) return topLeft;
  const xSplit = numAttr(pane, "xSplit") ?? 0;
  const ySplit = numAttr(pane, "ySplit") ?? 0;
  if (xSplit <= 0 && ySplit <= 0) return undefined;
  return columnLetter(Math.trunc(xSplit) + 1) + String(Math.trunc(ySplit) + 1);
}

function parseAutoFilter(root: XmlNode): string | undefined {
  return textAttr(firstDescendant(root, "autoFilter"), "ref");
}

function parseColumnWidths(root: XmlNode, colCount: number): number[] | undefined {
  const limit = Math.min(colCount, MAX_COLUMN_WIDTHS);
  if (limit <= 0) return undefined;
  const widths: number[] = [];
  for (const col of descendants(root, "col")) {
    const min = numAttr(col, "min");
    const max = numAttr(col, "max");
    const width = numAttr(col, "width");
    if (min === undefined || max === undefined || width === undefined) continue;
    const start = Math.max(1, Math.trunc(min));
    const end = Math.min(Math.trunc(max), limit);
    for (let index = start; index <= end; index += 1) {
      widths[index - 1] = Math.round(width * 100) / 100;
    }
  }
  if (widths.length === 0) return undefined;
  const filled: number[] = [];
  for (let index = 0; index < widths.length; index += 1) filled.push(widths[index] ?? 0);
  return filled;
}

// ---------------------------------------------------------------------------
// Worksheet
// ---------------------------------------------------------------------------

function parseWorksheetXml(
  xml: string,
  name: string,
  shared: string[],
  maxRows: number,
  maxFormulas: number,
): XlsxSheetDetail {
  const root = parseXml(xml);
  const dimensionRaw = textAttr(firstDescendant(root, "dimension"), "ref");
  const sheetData = firstDescendant(root, "sheetData");
  const sharedFormulas = new Map<string, string>();
  const formulas: Array<{ cell: string; formula: string }> = [];
  const previewRows: Array<{ cells: Map<number, string> }> = [];
  let maxRow = 0;
  let maxCol = 0;
  let previousRow = 0;

  for (const rowNode of childElements(sheetData, "row")) {
    previousRow += 1;
    const rowNumber = numAttr(rowNode, "r") ?? previousRow;
    previousRow = Math.max(previousRow, rowNumber);
    const cells = new Map<number, string>();
    let previousCol = 0;
    for (const cell of childElements(rowNode, "c")) {
      previousCol += 1;
      const ref = textAttr(cell, "r");
      const parsedRef = parseCellRef(ref);
      const col = parsedRef ? parsedRef.col : previousCol;
      const cellRow = parsedRef ? parsedRef.row : rowNumber;
      previousCol = Math.max(previousCol, col);
      const text = clipText(cellText(cell, shared), MAX_CELL_CHARS);
      if (text.length > 0) {
        if (cellRow > maxRow) maxRow = cellRow;
        if (col > maxCol) maxCol = col;
        cells.set(col, text);
      }
      const formula = cellFormula(cell, sharedFormulas);
      if (formula !== undefined && formulas.length < maxFormulas) {
        formulas.push({ cell: ref ?? columnLetter(col) + String(cellRow), formula: clipText(formula, MAX_CELL_CHARS) });
      }
    }
    if (cells.size > 0 && previewRows.length < maxRows) previewRows.push({ cells });
  }

  const range = parseRange(dimensionRaw);
  let rowCount = 0;
  let colCount = 0;
  let dimension: string | undefined;
  if (range) {
    rowCount = range.endRow;
    colCount = range.endCol;
    dimension = dimensionRaw;
  } else if (maxRow > 0 && maxCol > 0) {
    rowCount = maxRow;
    colCount = maxCol;
    dimension = "A1:" + columnLetter(maxCol) + String(maxRow);
  }

  const previewColumns = Math.min(Math.max(maxCol, 0), MAX_PREVIEW_COLS);
  const matrix = previewRows.map((row) => {
    const values: string[] = [];
    for (let col = 1; col <= previewColumns; col += 1) values.push(row.cells.get(col) ?? "");
    return values;
  });
  const headers = matrix.length > 0 ? matrix[0] : undefined;
  const rows = matrix.slice(1);

  const detail: XlsxSheetDetail = {
    name,
    rowCount,
    colCount,
    rows,
    formulas,
    merged: parseMergedCells(root),
  };
  if (dimension !== undefined) detail.dimension = dimension;
  if (headers !== undefined) detail.headers = headers;
  const columnWidths = parseColumnWidths(root, colCount);
  if (columnWidths !== undefined) detail.columnWidths = columnWidths;
  const freezePane = parseFreezePane(root);
  if (freezePane !== undefined) detail.freezePane = freezePane;
  const autoFilter = parseAutoFilter(root);
  if (autoFilter !== undefined) detail.autoFilter = autoFilter;
  return detail;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parses a .xlsx package into a structured detail object.
 *
 * Sheet order is the workbook order (xl/workbook.xml + its rels), never file
 * name order. Throws XlsxDetailError (Chinese message) for every user-facing
 * failure; all caps are applied here so the returned object stays small enough
 * for a model context window.
 */
export async function parseXlsxDetail(buffer: Buffer, opts: XlsxParseOptions = {}): Promise<XlsxDetail> {
  try {
    return await parseXlsxDetailInner(buffer, opts);
  } catch (err) {
    if (err instanceof XlsxDetailError) throw err;
    throw new XlsxDetailError(
      "Excel 文档解析失败（文件可能已损坏或不是有效的 .xlsx）：" + (err instanceof Error ? err.message : String(err)),
    );
  }
}

async function parseXlsxDetailInner(buffer: Buffer, opts: XlsxParseOptions): Promise<XlsxDetail> {
  if (buffer.byteLength === 0) throw new XlsxDetailError("Excel 文件为空");
  if (buffer.byteLength > MAX_XLSX_BYTES) {
    throw new XlsxDetailError(
      "Excel 文件过大（当前 " +
        (buffer.byteLength / 1024 / 1024).toFixed(1) +
        "MB，上限 " +
        Math.round(MAX_XLSX_BYTES / 1024 / 1024) +
        "MB）",
    );
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new XlsxDetailError("无法打开 Excel 包（文件可能已损坏或不是有效的 .xlsx）");
  }
  assertNoZipBomb(zip);

  const workbookXml = await readTextPart(zip, "xl/workbook.xml");
  if (workbookXml === undefined) {
    throw new XlsxDetailError("Excel 工作簿缺少 xl/workbook.xml（可能不是 .xlsx）");
  }
  const workbookRoot = parseXml(workbookXml);
  const sheetNodes = childElements(firstDescendant(workbookRoot, "sheets"), "sheet");
  if (sheetNodes.length === 0) {
    throw new XlsxDetailError("Excel 工作簿中没有工作表");
  }

  const maxRows = clampInt(opts.maxRows, DEFAULT_MAX_ROWS, HARD_MAX_ROWS);
  const maxSheets = clampInt(opts.maxSheets, DEFAULT_MAX_SHEETS, HARD_MAX_SHEETS);
  const maxFormulas = clampInt(opts.maxFormulas, DEFAULT_MAX_FORMULAS, HARD_MAX_FORMULAS);

  const rels = await readRelationships(zip, "xl/_rels/workbook.xml.rels", "xl");
  const sharedXml = await readTextPart(zip, "xl/sharedStrings.xml");
  const shared = sharedXml === undefined ? [] : parseSharedStrings(parseXml(sharedXml));

  const sheets: XlsxSheetDetail[] = [];
  for (let index = 0; index < sheetNodes.length && sheets.length < maxSheets; index += 1) {
    const sheetNode = sheetNodes[index];
    const name = textAttr(sheetNode, "name") ?? "Sheet" + (index + 1);
    const relId = textAttr(sheetNode, "r:id");
    const target = relId ? rels.get(relId) : undefined;
    const path = target ?? "xl/worksheets/sheet" + (index + 1) + ".xml";
    const xml = await readTextPart(zip, path);
    if (xml === undefined) {
      sheets.push({ name, rowCount: 0, colCount: 0, rows: [], formulas: [], merged: [] });
      continue;
    }
    sheets.push(parseWorksheetXml(xml, name, shared, maxRows, maxFormulas));
  }

  return { sheetCount: sheetNodes.length, sheets };
}

// ---------------------------------------------------------------------------
// Model-readable summary
// ---------------------------------------------------------------------------

const SUMMARY_HEADER_CHARS = 30;
const SUMMARY_CELL_CHARS = 40;
const SUMMARY_FORMULA_CHARS = 60;

/** Trims rendered lines to the character budget (line-boundary aware). */
function finalizeLines(lines: string[], maxChars: number): string {
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  const marker = "…（内容已截断）";
  if (maxChars <= marker.length + 1) return text.slice(0, Math.max(0, maxChars));
  const budget = Math.max(0, maxChars - marker.length - 1);
  let head = text.slice(0, budget);
  const lastBreak = head.lastIndexOf("\n");
  if (lastBreak > 0) head = head.slice(0, lastBreak);
  return head.length > 0 ? head + "\n" + marker : marker;
}

function formatSheetRow(cells: string[], maxCharsPerCell: number): string {
  return cells.map((cell) => clipText(cell, maxCharsPerCell)).join(" | ");
}

/**
 * Renders the detail as a compact Chinese summary for the model: one block per
 * sheet with scale, header row, a markdown-ish preview, formulas, merges,
 * frozen pane and auto filter. Bounded by maxChars (default 6000).
 */
export function renderXlsxDetailText(detail: XlsxDetail, opts: XlsxRenderOptions = {}): string {
  const maxChars = clampInt(opts.maxChars, DEFAULT_SUMMARY_CHARS, 60000);
  const lines: string[] = ["【Excel 概览】"];
  const shownNote = detail.sheets.length < detail.sheetCount ? "（仅展示前 " + detail.sheets.length + " 个）" : "";
  lines.push("- 工作表：" + detail.sheetCount + " 个" + shownNote);

  detail.sheets.forEach((sheet, index) => {
    lines.push("");
    lines.push("【表 " + (index + 1) + "】" + sheet.name);
    lines.push(
      "- 规模：" + sheet.rowCount + " 行 × " + sheet.colCount + " 列" + (sheet.dimension ? "，范围 " + sheet.dimension : ""),
    );
    if (sheet.headers) lines.push("- 表头：" + formatSheetRow(sheet.headers, SUMMARY_HEADER_CHARS));
    const previewRowCount = (sheet.headers ? 1 : 0) + sheet.rows.length;
    if (previewRowCount > 0) {
      lines.push("- 预览（" + previewRowCount + " 行）：");
      if (sheet.headers) lines.push("  | " + formatSheetRow(sheet.headers, SUMMARY_CELL_CHARS) + " |");
      for (const row of sheet.rows) lines.push("  | " + formatSheetRow(row, SUMMARY_CELL_CHARS) + " |");
      if (sheet.rowCount > previewRowCount) lines.push("  （仅预览前 " + previewRowCount + " 行）");
    } else {
      lines.push("- 预览：（无数据）");
    }
    if (sheet.formulas.length > 0) {
      const items = sheet.formulas.map((item) => item.cell + " = " + clipText(item.formula, SUMMARY_FORMULA_CHARS));
      lines.push("- 公式（" + sheet.formulas.length + " 个）：" + items.join("；"));
    }
    if (sheet.merged.length > 0) lines.push("- 合并单元格：" + sheet.merged.join("、"));
    if (sheet.freezePane !== undefined) lines.push("- 冻结窗格：" + sheet.freezePane);
    if (sheet.autoFilter !== undefined) lines.push("- 自动筛选：" + sheet.autoFilter);
  });

  return finalizeLines(lines, maxChars);
}
