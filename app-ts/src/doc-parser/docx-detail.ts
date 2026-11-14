import JSZip from "jszip";

/**
 * Word (.docx) DETAIL projection: page setup, styles/fonts, paragraph + run
 * formatting, table merge structure, headers/footers and core properties.
 *
 * Layer: doc-parser (format knowledge only — no HTTP, no repositories, no LLM).
 * This is the SECOND parsing level next to `parseDocxSections` (docx.ts): that
 * one projects headings + body text for import/切章, this one reads the OOXML
 * package itself so an agent can reproduce a user template faithfully.
 *
 * OOXML is read with a tiny hand-written scanner over JSZip entry text: no XML
 * dependency is added, and DOCTYPE / custom entities are NEVER expanded (only
 * the five predefined entities and numeric character references are decoded),
 * so a hostile package cannot trigger entity expansion. Zip-bomb guards:
 * per-entry uncompressed size, part size and node count are all bounded, and
 * every array the detail exposes has a hard cap.
 */

/** File-size ceiling for one .docx (same product limit as manuscript import). */
export const MAX_DOCX_BYTES = 20 * 1024 * 1024;
/** Uncompressed ceiling for ONE zip entry (zip-bomb guard). */
export const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;
/** Parsed XML part ceiling (characters) — a single huge part is skipped as an error. */
const MAX_XML_PART_CHARS = 16 * 1024 * 1024;
/** Structural node ceiling while scanning one part (zip-bomb / pathological XML guard). */
const MAX_XML_NODES = 400_000;
const MAX_SECTIONS = 20;
const MAX_STYLES = 40;
const MAX_RUNS_PER_PARAGRAPH = 20;
const MAX_CELLS_PER_ROW = 16;
const MAX_CELL_TEXT_CHARS = 500;
const MAX_HEADER_PARTS = 10;
const MAX_HEADER_PARAGRAPHS = 10;
const MAX_HEADER_TEXT_CHARS = 120;

export const DEFAULT_MAX_PARAGRAPHS = 40;
export const DEFAULT_MAX_TABLES = 8;
export const DEFAULT_MAX_ROWS_PER_TABLE = 30;
export const HARD_MAX_PARAGRAPHS = 200;
export const HARD_MAX_TABLES = 20;
export const HARD_MAX_ROWS_PER_TABLE = 100;
/** Summary text ceiling keeps one tool result inside the model context budget. */
export const DEFAULT_SUMMARY_CHARS = 6000;

/** Which detail blocks the rendered summary should contain (default: all). */
export const DOCX_DETAIL_FOCUS = [
  "page",
  "styles",
  "fonts",
  "paragraphs",
  "tables",
  "headers",
  "metadata",
] as const;

export type DocxDetailFocus = (typeof DOCX_DETAIL_FOCUS)[number];

export interface DocxDetailOptions {
  /** Only controls the rendered summary, not what is parsed (parsing is bounded anyway). */
  focus?: readonly DocxDetailFocus[];
  /** Body paragraphs to keep (0 = none), default 40, hard cap 200. */
  maxParagraphs?: number;
  /** Tables to keep, default 8, hard cap 20. */
  maxTables?: number;
  /** Rows per table to keep, default 30, hard cap 100. */
  maxRowsPerTable?: number;
}

export interface DocxMarginsInfo {
  topTwips?: number;
  rightTwips?: number;
  bottomTwips?: number;
  leftTwips?: number;
  headerTwips?: number;
  footerTwips?: number;
  gutterTwips?: number;
  topMm?: number;
  rightMm?: number;
  bottomMm?: number;
  leftMm?: number;
  headerMm?: number;
  footerMm?: number;
  gutterMm?: number;
}

export interface DocxPageRef {
  /** w:type: default / first / even */
  type: string;
  /** resolved package part, e.g. word/header1.xml */
  target?: string;
}

export interface DocxPageInfo {
  widthTwips?: number;
  heightTwips?: number;
  widthMm?: number;
  heightMm?: number;
  orientation?: "portrait" | "landscape";
  /** Detected paper name (A4 / Letter), when the size matches a known format. */
  paper?: string;
  margins?: DocxMarginsInfo;
  columns?: { count?: number; spaceTwips?: number; spaceMm?: number };
  headerRefs: DocxPageRef[];
  footerRefs: DocxPageRef[];
  titlePage?: boolean;
  /** Total w:sectPr count (paragraph-level + body-level); the fields above describe the first one. */
  sectionCount: number;
}

export interface DocxFontsInfo {
  ascii?: string;
  eastAsia?: string;
  hAnsi?: string;
  cs?: string;
  sizePt?: number;
  /** Complex-script size (w:szCs), half-points converted to pt. */
  sizeCsPt?: number;
  lang?: string;
  eastAsiaLang?: string;
}

export interface DocxStyleInfo {
  styleId: string;
  name?: string;
  type?: string;
  basedOn?: string;
  /** Built-in label (Normal / Title / Heading 1-3) when the style is one of them. */
  builtin?: string;
  asciiFont?: string;
  eastAsiaFont?: string;
  sizePt?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  outlineLevel?: number;
  alignment?: string;
}

export interface DocxRunInfo {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: string;
  strike?: boolean;
  color?: string;
  asciiFont?: string;
  eastAsiaFont?: string;
  sizePt?: number;
  verticalAlign?: string;
}

export interface DocxIndentInfo {
  leftTwips?: number;
  rightTwips?: number;
  firstLineTwips?: number;
  hangingTwips?: number;
}

export interface DocxSpacingInfo {
  beforeTwips?: number;
  afterTwips?: number;
  lineTwips?: number;
  lineRule?: string;
}

export interface DocxParagraphInfo {
  index: number;
  styleId?: string;
  alignment?: string;
  indent?: DocxIndentInfo;
  spacing?: DocxSpacingInfo;
  numbering?: { numId?: string; level?: number };
  text: string;
  runs: DocxRunInfo[];
  /** Runs that carried no explicit formatting (only counted, not described). */
  plainRunCount: number;
}

export interface DocxCellInfo {
  text: string;
  /** Horizontal merge width (>1 when w:gridSpan is set). */
  gridSpan?: number;
  /** Vertical merge state (w:vMerge). */
  verticalMerge?: "restart" | "continue";
  shading?: string;
}

export interface DocxRowInfo {
  header?: boolean;
  cells: DocxCellInfo[];
}

export interface DocxTableInfo {
  index: number;
  styleId?: string;
  width?: { twips?: number; percent?: number; type?: string };
  gridColumns: number[];
  rowCount: number;
  columnCount: number;
  rows: DocxRowInfo[];
  /** true when rows were dropped by maxRowsPerTable. */
  truncated: boolean;
}

export interface DocxHeaderFooterInfo {
  part: string;
  kind: "header" | "footer";
  /** e.g. "第 1 节 default" */
  referencedBy: string[];
  paragraphs: string[];
  paragraphCount: number;
}

export interface DocxMetadataInfo {
  title?: string;
  creator?: string;
  lastModifiedBy?: string;
  subject?: string;
  keywords?: string;
  modified?: string;
}

export interface DocxDetail {
  page: DocxPageInfo;
  fonts: DocxFontsInfo;
  /** Paragraph styles from word/styles.xml (bounded). */
  styles: DocxStyleInfo[];
  /** All paragraph/table/character styles present in the package (before the cap). */
  styleCount: number;
  paragraphs: DocxParagraphInfo[];
  paragraphCount: number;
  paragraphsTruncated: boolean;
  tables: DocxTableInfo[];
  tableCount: number;
  headers: DocxHeaderFooterInfo[];
  metadata?: DocxMetadataInfo;
  stats: { runCount: number; fontSizeSet: number[] };
  focus: DocxDetailFocus[];
  /** Byte size of the package that was parsed. */
  byteLength: number;
}

export type DocxDetailParseResult =
  | { ok: true; detail: DocxDetail }
  | { ok: false; error: string };

/** Internal parse failure carrying a user-readable Chinese reason. */
class DocxDetailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocxDetailError";
  }
}

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
 * Minimal OOXML scanner: builds a light element tree with attributes and text
 * nodes. Comments / processing instructions / DOCTYPE / CDATA are consumed but
 * never expanded; malformed nesting is tolerated by popping to the matching
 * open tag. Node count is capped so a pathological part cannot exhaust memory.
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
      throw new DocxDetailError("Word 文档结构过大（XML 节点数超过上限），无法完整解析");
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

/** Depth-first descendants in document order (bounded by the node cap of the scanner). */
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

/** Inline text of one run: w:t plus tab/break markers, in document order. */
function inlineText(node: XmlNode): string {
  if (node.name === TEXT_NODE) return node.text;
  if (node.name === "w:t") return nodeText(node);
  if (node.name === "w:tab") return "\t";
  if (node.name === "w:br" || node.name === "w:cr") return "\n";
  if (node.name === "w:noBreakHyphen") return "-";
  let out = "";
  for (const child of node.children) out += inlineText(child);
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

/** OOXML toggle property: present without an explicit false value means ON. */
function toggle(node: XmlNode | undefined): boolean | undefined {
  if (!node) return undefined;
  const value = (textAttr(node, "w:val") ?? "").toLowerCase();
  if (value === "0" || value === "false" || value === "off") return false;
  return true;
}

/** twips (1/20 pt, 1/1440 in) to millimetres, one decimal. */
function twipsToMm(twips: number | undefined): number | undefined {
  if (twips === undefined) return undefined;
  return Math.round((twips / 1440) * 25.4 * 10) / 10;
}

function halfPointsToPt(halfPoints: number | undefined): number | undefined {
  if (halfPoints === undefined) return undefined;
  return halfPoints / 2;
}

function detectPaper(widthTwips: number | undefined, heightTwips: number | undefined): string | undefined {
  if (widthTwips === undefined || heightTwips === undefined) return undefined;
  const near = (value: number, target: number): boolean => Math.abs(value - target) <= 60;
  if (near(widthTwips, 11906) && near(heightTwips, 16838)) return "A4";
  if (near(widthTwips, 16838) && near(heightTwips, 11906)) return "A4 横向";
  if (near(widthTwips, 12240) && near(heightTwips, 15840)) return "Letter";
  if (near(widthTwips, 15840) && near(heightTwips, 12240)) return "Letter 横向";
  return undefined;
}

function clampInt(value: number | undefined, fallback: number, hardMax: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (rounded < 0) return 0;
  return rounded > hardMax ? hardMax : rounded;
}

function resolveFocus(focus: readonly DocxDetailFocus[] | undefined): DocxDetailFocus[] {
  if (!focus || focus.length === 0) return [...DOCX_DETAIL_FOCUS];
  const seen = new Set<DocxDetailFocus>();
  for (const item of focus) {
    if (DOCX_DETAIL_FOCUS.includes(item)) seen.add(item);
  }
  return seen.size > 0 ? [...seen] : [...DOCX_DETAIL_FOCUS];
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
  for (const name of Object.keys(zip.files)) {
    const file = zip.file(name);
    if (!file || file.dir) continue;
    const size = entryUncompressedSize(file);
    if (size !== undefined && size > MAX_ZIP_ENTRY_BYTES) {
      throw new DocxDetailError(
        "Word 包内单个条目解压后超过 " + Math.round(MAX_ZIP_ENTRY_BYTES / 1024 / 1024) + "MB（疑似压缩炸弹），已拒绝解析",
      );
    }
  }
}

async function readTextPart(zip: JSZip, path: string): Promise<string | undefined> {
  const file = zip.file(path);
  if (!file || file.dir) return undefined;
  const declared = entryUncompressedSize(file);
  if (declared !== undefined && declared > MAX_ZIP_ENTRY_BYTES) {
    throw new DocxDetailError("Word 包内的 " + path + " 解压后过大，已跳过");
  }
  const data = await file.async("uint8array");
  if (data.byteLength > MAX_ZIP_ENTRY_BYTES) {
    throw new DocxDetailError("Word 包内的 " + path + " 解压后过大，已跳过");
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  if (text.length > MAX_XML_PART_CHARS) {
    throw new DocxDetailError("Word 包内的 " + path + " 超过解析上限（" + Math.round(MAX_XML_PART_CHARS / 1024 / 1024) + "MB 文本）");
  }
  return text;
}

/** Relationship id → resolved package path for one .rels part (missing rels = empty map). */
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
// Page / sections
// ---------------------------------------------------------------------------

function parseHeaderFooterRefs(sectPr: XmlNode, kind: "header" | "footer", rels: Map<string, string>): DocxPageRef[] {
  const refs: DocxPageRef[] = [];
  for (const node of childElements(sectPr, "w:" + kind + "Reference")) {
    const ref: DocxPageRef = { type: textAttr(node, "w:type") ?? "default" };
    const relId = textAttr(node, "r:id") ?? textAttr(node, "id");
    const target = relId ? rels.get(relId) : undefined;
    if (target) ref.target = target;
    refs.push(ref);
  }
  return refs;
}

function parsePage(sectPr: XmlNode | undefined, rels: Map<string, string>, sectionCount: number): DocxPageInfo {
  const info: DocxPageInfo = {
    headerRefs: [],
    footerRefs: [],
    sectionCount,
  };
  if (!sectPr) return info;
  const pgSz = firstChild(sectPr, "w:pgSz");
  const widthTwips = numAttr(pgSz, "w:w");
  const heightTwips = numAttr(pgSz, "w:h");
  if (widthTwips !== undefined) info.widthTwips = widthTwips;
  if (heightTwips !== undefined) info.heightTwips = heightTwips;
  info.widthMm = twipsToMm(widthTwips);
  info.heightMm = twipsToMm(heightTwips);
  const orient = textAttr(pgSz, "w:orient");
  if (orient === "landscape" || orient === "portrait") info.orientation = orient;
  else if (widthTwips !== undefined && heightTwips !== undefined) {
    info.orientation = widthTwips > heightTwips ? "landscape" : "portrait";
  }
  info.paper = detectPaper(widthTwips, heightTwips);

  const pgMar = firstChild(sectPr, "w:pgMar");
  if (pgMar) {
    const margins: DocxMarginsInfo = {};
    const top = numAttr(pgMar, "w:top");
    const right = numAttr(pgMar, "w:right");
    const bottom = numAttr(pgMar, "w:bottom");
    const left = numAttr(pgMar, "w:left");
    const header = numAttr(pgMar, "w:header");
    const footer = numAttr(pgMar, "w:footer");
    const gutter = numAttr(pgMar, "w:gutter");
    if (top !== undefined) margins.topTwips = top;
    if (right !== undefined) margins.rightTwips = right;
    if (bottom !== undefined) margins.bottomTwips = bottom;
    if (left !== undefined) margins.leftTwips = left;
    if (header !== undefined) margins.headerTwips = header;
    if (footer !== undefined) margins.footerTwips = footer;
    if (gutter !== undefined) margins.gutterTwips = gutter;
    margins.topMm = twipsToMm(top);
    margins.rightMm = twipsToMm(right);
    margins.bottomMm = twipsToMm(bottom);
    margins.leftMm = twipsToMm(left);
    margins.headerMm = twipsToMm(header);
    margins.footerMm = twipsToMm(footer);
    margins.gutterMm = twipsToMm(gutter);
    info.margins = margins;
  }

  const cols = firstChild(sectPr, "w:cols");
  if (cols) {
    const count = numAttr(cols, "w:num");
    const space = numAttr(cols, "w:space");
    info.columns = {
      ...(count !== undefined ? { count } : {}),
      ...(space !== undefined ? { spaceTwips: space, spaceMm: twipsToMm(space) } : {}),
    };
  }
  info.headerRefs = parseHeaderFooterRefs(sectPr, "header", rels);
  info.footerRefs = parseHeaderFooterRefs(sectPr, "footer", rels);
  const titlePg = firstChild(sectPr, "w:titlePg");
  if (titlePg) info.titlePage = true;
  return info;
}

// ---------------------------------------------------------------------------
// Styles / fonts
// ---------------------------------------------------------------------------

function parseFonts(rPr: XmlNode | undefined): { ascii?: string; eastAsia?: string; hAnsi?: string; cs?: string } {
  const fonts = firstChild(rPr, "w:rFonts");
  if (!fonts) return {};
  const out: { ascii?: string; eastAsia?: string; hAnsi?: string; cs?: string } = {};
  const ascii = textAttr(fonts, "w:ascii");
  const eastAsia = textAttr(fonts, "w:eastAsia");
  const hAnsi = textAttr(fonts, "w:hAnsi");
  const cs = textAttr(fonts, "w:cs");
  if (ascii) out.ascii = ascii;
  if (eastAsia) out.eastAsia = eastAsia;
  if (hAnsi) out.hAnsi = hAnsi;
  if (cs) out.cs = cs;
  return out;
}

const BUILTIN_BY_ID: Record<string, string> = {
  Normal: "Normal",
  Title: "Title",
  Heading1: "Heading 1",
  Heading2: "Heading 2",
  Heading3: "Heading 3",
};

/** Resolves the built-in label from the style id or the localized style name. */
function builtinLabel(styleId: string | undefined, name: string | undefined): string | undefined {
  if (styleId && BUILTIN_BY_ID[styleId]) return BUILTIN_BY_ID[styleId];
  const value = (name ?? "").trim().toLowerCase();
  if (value === "normal" || value === "正文") return "Normal";
  if (value === "title" || value === "标题") return "Title";
  for (let level = 1; level <= 3; level += 1) {
    if (value === "heading " + level || value === "标题 " + level || value === "标题" + level) {
      return "Heading " + level;
    }
  }
  return undefined;
}

function parseStyles(root: XmlNode): { fonts: DocxFontsInfo; styles: DocxStyleInfo[]; styleCount: number } {
  // The scanner returns a synthetic root: locate the w:styles element first.
  const stylesRoot = root.name === "w:styles" ? root : (firstDescendant(root, "w:styles") ?? root);
  const fonts: DocxFontsInfo = {};
  const defaults = firstChild(stylesRoot, "w:docDefaults");
  const rPrDefault = defaults ? firstDescendant(defaults, "w:rPrDefault") : undefined;
  const defaultRPr = rPrDefault ? firstChild(rPrDefault, "w:rPr") : undefined;
  if (defaultRPr) {
    const fontInfo = parseFonts(defaultRPr);
    if (fontInfo.ascii) fonts.ascii = fontInfo.ascii;
    if (fontInfo.eastAsia) fonts.eastAsia = fontInfo.eastAsia;
    if (fontInfo.hAnsi) fonts.hAnsi = fontInfo.hAnsi;
    if (fontInfo.cs) fonts.cs = fontInfo.cs;
    const sizePt = halfPointsToPt(numAttr(firstChild(defaultRPr, "w:sz"), "w:val"));
    if (sizePt !== undefined) fonts.sizePt = sizePt;
    const sizeCsPt = halfPointsToPt(numAttr(firstChild(defaultRPr, "w:szCs"), "w:val"));
    if (sizeCsPt !== undefined) fonts.sizeCsPt = sizeCsPt;
    const lang = firstChild(defaultRPr, "w:lang");
    const langVal = textAttr(lang, "w:val");
    const eastAsiaLang = textAttr(lang, "w:eastAsia");
    if (langVal) fonts.lang = langVal;
    if (eastAsiaLang) fonts.eastAsiaLang = eastAsiaLang;
  }

  const styleNodes = childElements(stylesRoot, "w:style");
  const styles: DocxStyleInfo[] = [];
  for (const node of styleNodes) {
    if (styles.length >= MAX_STYLES) break;
    const styleId = textAttr(node, "w:styleId") ?? "";
    if (styleId === "") continue;
    const name = textAttr(firstChild(node, "w:name"), "w:val");
    const type = textAttr(node, "w:type");
    const info: DocxStyleInfo = { styleId };
    if (name) info.name = name;
    if (type) info.type = type;
    const basedOn = textAttr(firstChild(node, "w:basedOn"), "w:val");
    if (basedOn) info.basedOn = basedOn;
    const builtin = builtinLabel(styleId, name);
    if (builtin) info.builtin = builtin;
    const rPr = firstChild(node, "w:rPr");
    const fontInfo = parseFonts(rPr);
    if (fontInfo.ascii) info.asciiFont = fontInfo.ascii;
    if (fontInfo.eastAsia) info.eastAsiaFont = fontInfo.eastAsia;
    const sizePt = halfPointsToPt(numAttr(firstChild(rPr, "w:sz"), "w:val"));
    if (sizePt !== undefined) info.sizePt = sizePt;
    const bold = toggle(firstChild(rPr, "w:b"));
    if (bold !== undefined) info.bold = bold;
    const italic = toggle(firstChild(rPr, "w:i"));
    if (italic !== undefined) info.italic = italic;
    const color = textAttr(firstChild(rPr, "w:color"), "w:val");
    if (color && color !== "auto") info.color = color;
    const pPr = firstChild(node, "w:pPr");
    const outline = numAttr(firstChild(pPr, "w:outlineLvl"), "w:val");
    if (outline !== undefined) info.outlineLevel = outline;
    const alignment = textAttr(firstChild(pPr, "w:jc"), "w:val");
    if (alignment) info.alignment = alignment;
    styles.push(info);
  }
  return { fonts, styles, styleCount: styleNodes.length };
}

// ---------------------------------------------------------------------------
// Body: paragraphs + tables
// ---------------------------------------------------------------------------

function parseRun(run: XmlNode): DocxRunInfo {
  const rPr = firstChild(run, "w:rPr");
  const info: DocxRunInfo = { text: inlineText(run) };
  const bold = toggle(firstChild(rPr, "w:b"));
  if (bold !== undefined) info.bold = bold;
  const italic = toggle(firstChild(rPr, "w:i"));
  if (italic !== undefined) info.italic = italic;
  const underlineNode = firstChild(rPr, "w:u");
  const underline = textAttr(underlineNode, "w:val");
  if (underline && underline !== "none") info.underline = underline;
  const strike = toggle(firstChild(rPr, "w:strike"));
  if (strike !== undefined) info.strike = strike;
  const color = textAttr(firstChild(rPr, "w:color"), "w:val");
  if (color && color !== "auto") info.color = color;
  const fonts = parseFonts(rPr);
  if (fonts.ascii) info.asciiFont = fonts.ascii;
  if (fonts.eastAsia) info.eastAsiaFont = fonts.eastAsia;
  const sizePt = halfPointsToPt(numAttr(firstChild(rPr, "w:sz"), "w:val"));
  if (sizePt !== undefined) info.sizePt = sizePt;
  const verticalAlign = textAttr(firstChild(rPr, "w:vertAlign"), "w:val");
  if (verticalAlign) info.verticalAlign = verticalAlign;
  return info;
}

function hasRunFormatting(run: DocxRunInfo): boolean {
  return (
    run.bold === true ||
    run.italic === true ||
    run.underline !== undefined ||
    run.strike === true ||
    run.color !== undefined ||
    run.asciiFont !== undefined ||
    run.eastAsiaFont !== undefined ||
    run.sizePt !== undefined ||
    run.verticalAlign !== undefined
  );
}

function parseParagraph(paragraph: XmlNode, index: number): DocxParagraphInfo {
  const pPr = firstChild(paragraph, "w:pPr");
  const info: DocxParagraphInfo = { index, text: "", runs: [], plainRunCount: 0 };
  const styleId = textAttr(firstChild(pPr, "w:pStyle"), "w:val");
  if (styleId) info.styleId = styleId;
  const alignment = textAttr(firstChild(pPr, "w:jc"), "w:val");
  if (alignment) info.alignment = alignment;

  const ind = firstChild(pPr, "w:ind");
  if (ind) {
    const indent: DocxIndentInfo = {};
    const left = numAttr(ind, "w:left") ?? numAttr(ind, "w:start");
    const right = numAttr(ind, "w:right") ?? numAttr(ind, "w:end");
    const firstLine = numAttr(ind, "w:firstLine");
    const hanging = numAttr(ind, "w:hanging");
    if (left !== undefined) indent.leftTwips = left;
    if (right !== undefined) indent.rightTwips = right;
    if (firstLine !== undefined) indent.firstLineTwips = firstLine;
    if (hanging !== undefined) indent.hangingTwips = hanging;
    if (Object.keys(indent).length > 0) info.indent = indent;
  }

  const spacing = firstChild(pPr, "w:spacing");
  if (spacing) {
    const spacingInfo: DocxSpacingInfo = {};
    const before = numAttr(spacing, "w:before");
    const after = numAttr(spacing, "w:after");
    const line = numAttr(spacing, "w:line");
    const lineRule = textAttr(spacing, "w:lineRule");
    if (before !== undefined) spacingInfo.beforeTwips = before;
    if (after !== undefined) spacingInfo.afterTwips = after;
    if (line !== undefined) spacingInfo.lineTwips = line;
    if (lineRule) spacingInfo.lineRule = lineRule;
    if (Object.keys(spacingInfo).length > 0) info.spacing = spacingInfo;
  }

  const numPr = firstChild(pPr, "w:numPr");
  if (numPr) {
    const numbering: { numId?: string; level?: number } = {};
    const numId = textAttr(firstChild(numPr, "w:numId"), "w:val");
    const level = numAttr(firstChild(numPr, "w:ilvl"), "w:val");
    if (numId) numbering.numId = numId;
    if (level !== undefined) numbering.level = level;
    if (Object.keys(numbering).length > 0) info.numbering = numbering;
  }

  const runs = descendants(paragraph, "w:r");
  let text = "";
  for (const runNode of runs) {
    const run = parseRun(runNode);
    text += run.text;
    if (hasRunFormatting(run)) {
      if (info.runs.length < MAX_RUNS_PER_PARAGRAPH) info.runs.push(run);
    } else {
      info.plainRunCount += 1;
    }
  }
  info.text = text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
  return info;
}

function parseCell(cell: XmlNode): DocxCellInfo {
  const tcPr = firstChild(cell, "w:tcPr");
  const info: DocxCellInfo = { text: "" };
  const gridSpan = numAttr(firstChild(tcPr, "w:gridSpan"), "w:val");
  if (gridSpan !== undefined && gridSpan > 1) info.gridSpan = gridSpan;
  const vMerge = firstChild(tcPr, "w:vMerge");
  if (vMerge) {
    const value = (textAttr(vMerge, "w:val") ?? "").toLowerCase();
    info.verticalMerge = value === "restart" ? "restart" : "continue";
  }
  const shading = textAttr(firstChild(tcPr, "w:shd"), "w:fill");
  if (shading && shading !== "auto") info.shading = shading;
  const paragraphs = childElements(cell, "w:p");
  const parts: string[] = [];
  for (const paragraph of paragraphs) {
    const value = descendants(paragraph, "w:r")
      .map((run) => inlineText(run))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (value.length > 0) parts.push(value);
  }
  const text = parts.join("\n");
  info.text = text.length > MAX_CELL_TEXT_CHARS ? text.slice(0, MAX_CELL_TEXT_CHARS) + "…" : text;
  return info;
}

function parseTable(table: XmlNode, index: number, maxRowsPerTable: number): DocxTableInfo {
  const tblPr = firstChild(table, "w:tblPr");
  const info: DocxTableInfo = { index, gridColumns: [], rowCount: 0, columnCount: 0, rows: [], truncated: false };
  const styleId = textAttr(firstChild(tblPr, "w:tblStyle"), "w:val");
  if (styleId) info.styleId = styleId;
  const tblW = firstChild(tblPr, "w:tblW");
  if (tblW) {
    const width: { twips?: number; percent?: number; type?: string } = {};
    const type = textAttr(tblW, "w:type");
    const value = numAttr(tblW, "w:w");
    if (type) width.type = type;
    if (value !== undefined) {
      if (type === "pct") width.percent = Math.round(value / 50);
      else width.twips = value;
    }
    if (Object.keys(width).length > 0) info.width = width;
  }
  const tblGrid = firstChild(table, "w:tblGrid");
  for (const gridCol of childElements(tblGrid, "w:gridCol")) {
    const width = numAttr(gridCol, "w:w");
    if (width !== undefined) info.gridColumns.push(width);
  }
  const rows = childElements(table, "w:tr");
  info.rowCount = rows.length;
  let columnCount = info.gridColumns.length;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const rowInfo: DocxRowInfo = { cells: [] };
    const trPr = firstChild(row, "w:trPr");
    if (trPr && firstChild(trPr, "w:tblHeader")) rowInfo.header = true;
    let span = 0;
    for (const cell of childElements(row, "w:tc")) {
      if (rowInfo.cells.length >= MAX_CELLS_PER_ROW) break;
      const cellInfo = parseCell(cell);
      rowInfo.cells.push(cellInfo);
      span += cellInfo.gridSpan ?? 1;
    }
    if (span > columnCount) columnCount = span;
    if (rowIndex < maxRowsPerTable) info.rows.push(rowInfo);
    else info.truncated = true;
  }
  info.columnCount = columnCount;
  return info;
}

/** First-level body children: paragraphs and tables (w:sdt wrappers are descended). */
function walkBody(container: XmlNode, visit: (node: XmlNode, kind: "paragraph" | "table") => void): void {
  for (const child of childElements(container)) {
    if (child.name === "w:p") visit(child, "paragraph");
    else if (child.name === "w:tbl") visit(child, "table");
    else if (child.name === "w:sdt") {
      const content = firstChild(child, "w:sdtContent");
      if (content) walkBody(content, visit);
    }
  }
}

// ---------------------------------------------------------------------------
// Headers / footers / metadata
// ---------------------------------------------------------------------------

function partBaseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

async function parseHeaderFooterParts(
  zip: JSZip,
  sectionRefs: Array<{ refs: DocxPageRef[] }>,
): Promise<DocxHeaderFooterInfo[]> {
  const kindByPart = new Map<string, "header" | "footer">();
  for (const path of Object.keys(zip.files)) {
    const base = partBaseName(path);
    if (/^header\d*\.xml$/i.test(base)) kindByPart.set(path, "header");
    else if (/^footer\d*\.xml$/i.test(base)) kindByPart.set(path, "footer");
  }
  const out: DocxHeaderFooterInfo[] = [];
  for (const path of [...kindByPart.keys()].sort()) {
    if (out.length >= MAX_HEADER_PARTS) break;
    const kind = kindByPart.get(path) as "header" | "footer";
    const referencedBy: string[] = [];
    sectionRefs.forEach((section, index) => {
      for (const ref of section.refs) {
        if (ref.target === path) referencedBy.push("第 " + (index + 1) + " 节 " + ref.type);
      }
    });
    const text = await readTextPart(zip, path);
    const info: DocxHeaderFooterInfo = { part: path, kind, referencedBy, paragraphs: [], paragraphCount: 0 };
    if (text === undefined) {
      out.push(info);
      continue;
    }
    const root = parseXml(text);
    const body = firstDescendant(root, "w:body") ?? root;
    const paragraphs = descendants(body, "w:p");
    info.paragraphCount = paragraphs.length;
    for (const paragraph of paragraphs) {
      const value = descendants(paragraph, "w:r")
        .map((run) => inlineText(run))
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (value.length === 0) continue;
      if (info.paragraphs.length >= MAX_HEADER_PARAGRAPHS) break;
      info.paragraphs.push(value.length > MAX_HEADER_TEXT_CHARS ? value.slice(0, MAX_HEADER_TEXT_CHARS) + "…" : value);
    }
    out.push(info);
  }
  return out;
}

function firstByLocalName(root: XmlNode, localName: string): string | undefined {
  const wanted = localName.toLowerCase();
  const stack: XmlNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as XmlNode;
    if (node.name !== TEXT_NODE && node.name !== "#root") {
      const name = node.name.toLowerCase();
      const local = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
      if (local === wanted) {
        const value = nodeText(node).replace(/\s+/g, " ").trim();
        return value.length > 0 ? value : undefined;
      }
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]);
  }
  return undefined;
}

async function parseMetadata(zip: JSZip): Promise<DocxMetadataInfo | undefined> {
  const text = await readTextPart(zip, "docProps/core.xml");
  if (text === undefined) return undefined;
  const root = parseXml(text);
  const info: DocxMetadataInfo = {};
  const title = firstByLocalName(root, "title");
  const creator = firstByLocalName(root, "creator");
  const lastModifiedBy = firstByLocalName(root, "lastModifiedBy");
  const subject = firstByLocalName(root, "subject");
  const keywords = firstByLocalName(root, "keywords");
  const modified = firstByLocalName(root, "modified");
  if (title) info.title = title;
  if (creator) info.creator = creator;
  if (lastModifiedBy) info.lastModifiedBy = lastModifiedBy;
  if (subject) info.subject = subject;
  if (keywords) info.keywords = keywords;
  if (modified) info.modified = modified;
  return Object.keys(info).length > 0 ? info : undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parses a .docx package into a structured detail object.
 *
 * Never throws for user-facing failures: a file over the size limit, a
 * non-zip/corrupted package, a zip-bomb entry or a missing word/document.xml
 * all come back as { ok: false, error } in Chinese so the tool can hand the
 * reason to the model. Caps are applied here (maxParagraphs / maxTables /
 * maxRowsPerTable plus every hard limit above).
 */
export async function parseDocxDetail(
  buffer: Uint8Array,
  options: DocxDetailOptions = {},
): Promise<DocxDetailParseResult> {
  try {
    if (buffer.byteLength === 0) return { ok: false, error: "Word 文件为空" };
    if (buffer.byteLength > MAX_DOCX_BYTES) {
      return {
        ok: false,
        error: "Word 文件过大（当前 " + (buffer.byteLength / 1024 / 1024).toFixed(1) + "MB，上限 20MB）",
      };
    }
    const maxParagraphs = clampInt(options.maxParagraphs, DEFAULT_MAX_PARAGRAPHS, HARD_MAX_PARAGRAPHS);
    const maxTables = clampInt(options.maxTables, DEFAULT_MAX_TABLES, HARD_MAX_TABLES);
    const maxRowsPerTable = clampInt(options.maxRowsPerTable, DEFAULT_MAX_ROWS_PER_TABLE, HARD_MAX_ROWS_PER_TABLE);

    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } catch {
      return { ok: false, error: "无法打开 Word 包（文件可能已损坏或不是有效的 .docx）" };
    }
    assertNoZipBomb(zip);

    const documentXml = await readTextPart(zip, "word/document.xml");
    if (documentXml === undefined) {
      return { ok: false, error: "Word 文档缺少 word/document.xml（可能不是 .docx）" };
    }
    const documentRoot = parseXml(documentXml);
    const body = firstDescendant(documentRoot, "w:body") ?? documentRoot;

    const rels = await readRelationships(zip, "word/_rels/document.xml.rels", "word");
    const sectPrs = descendants(body, "w:sectPr").slice(0, MAX_SECTIONS);
    const sectionCount = descendants(body, "w:sectPr").length;
    const page = parsePage(sectPrs[0], rels, sectionCount);

    const stylesXml = await readTextPart(zip, "word/styles.xml");
    const stylesResult = stylesXml ? parseStyles(parseXml(stylesXml)) : { fonts: {}, styles: [], styleCount: 0 };

    const paragraphs: DocxParagraphInfo[] = [];
    const tables: DocxTableInfo[] = [];
    let paragraphCount = 0;
    let tableCount = 0;
    let runCount = 0;
    let paragraphsTruncated = false;
    const fontSizeSet = new Set<number>();
    if (stylesResult.fonts.sizePt !== undefined) fontSizeSet.add(stylesResult.fonts.sizePt);
    for (const style of stylesResult.styles) {
      if (style.sizePt !== undefined) fontSizeSet.add(style.sizePt);
    }

    walkBody(body, (node, kind) => {
      if (kind === "paragraph") {
        const paragraph = parseParagraph(node, paragraphCount);
        if (paragraph.text.length === 0) return;
        paragraphCount += 1;
        runCount += paragraph.runs.length + paragraph.plainRunCount;
        for (const run of paragraph.runs) {
          if (run.sizePt !== undefined) fontSizeSet.add(run.sizePt);
        }
        if (paragraphs.length < maxParagraphs) paragraphs.push(paragraph);
        else paragraphsTruncated = true;
        return;
      }
      const table = parseTable(node, tableCount, maxRowsPerTable);
      tableCount += 1;
      if (tables.length < maxTables) tables.push(table);
    });

    const headerParts = await parseHeaderFooterParts(
      zip,
      sectPrs.map((sectPr) => ({ refs: [...parseHeaderFooterRefs(sectPr, "header", rels), ...parseHeaderFooterRefs(sectPr, "footer", rels)] })),
    );
    const metadata = await parseMetadata(zip);

    const detail: DocxDetail = {
      page,
      fonts: stylesResult.fonts,
      styles: stylesResult.styles,
      styleCount: stylesResult.styleCount,
      paragraphs,
      paragraphCount,
      paragraphsTruncated,
      tables,
      tableCount,
      headers: headerParts,
      ...(metadata ? { metadata } : {}),
      stats: { runCount, fontSizeSet: [...fontSizeSet].sort((left, right) => left - right) },
      focus: resolveFocus(options.focus),
      byteLength: buffer.byteLength,
    };
    return { ok: true, detail };
  } catch (err) {
    if (err instanceof DocxDetailError) return { ok: false, error: err.message };
    return {
      ok: false,
      error: "Word 文档解析失败（文件可能已损坏或不是有效的 .docx）：" + (err instanceof Error ? err.message : String(err)),
    };
  }
}

// ---------------------------------------------------------------------------
// Model-readable summary
// ---------------------------------------------------------------------------

export interface DocxDetailRenderOptions {
  /** Blocks to render; defaults to the focus recorded on the detail. */
  focus?: readonly DocxDetailFocus[];
  /** Character budget, default 6000. */
  maxChars?: number;
  /** Display name shown in the header line (file name / cloud label). */
  name?: string;
}

const ALIGNMENT_LABELS: Record<string, string> = {
  left: "左对齐",
  start: "左对齐",
  center: "居中",
  right: "右对齐",
  end: "右对齐",
  both: "两端对齐",
  distribute: "分散对齐",
};

const MAX_RENDER_STYLES = 12;
const MAX_RUN_TEXT_CHARS = 40;
const MAX_PARAGRAPH_TEXT_CHARS = 140;

function formatPt(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return String(rounded) + "pt";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + "MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + "KB";
  return bytes + "B";
}

/** Joins the defined parts; returns undefined when nothing is left. */
function joinParts(parts: Array<string | undefined>, separator = "｜"): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return kept.length > 0 ? kept.join(separator) : undefined;
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + "…" : value;
}

function describeAlignment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return ALIGNMENT_LABELS[value] ?? value;
}

function describeIndent(indent: DocxIndentInfo | undefined): string | undefined {
  if (!indent) return undefined;
  const parts: string[] = [];
  if (indent.firstLineTwips !== undefined) parts.push("首行缩进 " + indent.firstLineTwips + " twips");
  if (indent.hangingTwips !== undefined) parts.push("悬挂缩进 " + indent.hangingTwips + " twips");
  if (indent.leftTwips !== undefined) parts.push("左缩进 " + indent.leftTwips + " twips");
  if (indent.rightTwips !== undefined) parts.push("右缩进 " + indent.rightTwips + " twips");
  return parts.length > 0 ? parts.join("，") : undefined;
}

function describeSpacing(spacing: DocxSpacingInfo | undefined): string | undefined {
  if (!spacing) return undefined;
  const parts: string[] = [];
  if (spacing.lineTwips !== undefined) {
    if (spacing.lineRule === "auto") {
      parts.push("行距 " + Math.round((spacing.lineTwips / 240) * 100) / 100 + " 倍");
    } else {
      parts.push("行距 " + spacing.lineTwips + " twips");
    }
  }
  if (spacing.beforeTwips !== undefined) parts.push("段前 " + spacing.beforeTwips + " twips");
  if (spacing.afterTwips !== undefined) parts.push("段后 " + spacing.afterTwips + " twips");
  return parts.length > 0 ? parts.join("，") : undefined;
}

/** One-line formatting description of a run (undefined for unformatted runs). */
function describeRun(run: DocxRunInfo): string | undefined {
  const parts: string[] = [];
  if (run.bold) parts.push("加粗");
  if (run.italic) parts.push("斜体");
  if (run.underline) parts.push("下划线(" + run.underline + ")");
  if (run.strike) parts.push("删除线");
  if (run.color) parts.push("颜色 " + run.color);
  if (run.verticalAlign) {
    parts.push(run.verticalAlign === "superscript" ? "上标" : run.verticalAlign === "subscript" ? "下标" : run.verticalAlign);
  }
  if (run.sizePt !== undefined) parts.push(formatPt(run.sizePt));
  if (run.eastAsiaFont) parts.push("中文字体 " + run.eastAsiaFont);
  if (run.asciiFont) parts.push("西文字体 " + run.asciiFont);
  if (parts.length === 0) return undefined;
  return parts.join(" ") + "「" + clip(run.text.replace(/\s+/g, " "), MAX_RUN_TEXT_CHARS) + "」";
}

function describeStyle(style: DocxStyleInfo): string {
  const head = "[" + style.styleId + "]" + (style.name && style.name !== style.styleId ? " " + style.name : "");
  const parts: string[] = [];
  if (style.sizePt !== undefined) parts.push(formatPt(style.sizePt));
  if (style.bold) parts.push("加粗");
  if (style.italic) parts.push("斜体");
  if (style.color) parts.push("颜色 " + style.color);
  if (style.outlineLevel !== undefined) parts.push("大纲级别 " + style.outlineLevel);
  const alignment = describeAlignment(style.alignment);
  if (alignment) parts.push(alignment);
  const fonts = [style.eastAsiaFont, style.asciiFont].filter((font): font is string => font !== undefined);
  if (fonts.length > 0) parts.push(fonts.join(" / "));
  if (style.basedOn) parts.push("基于 " + style.basedOn);
  const builtin = style.builtin ? "（内置 " + style.builtin + "）" : "";
  return "- " + head + builtin + (parts.length > 0 ? "：" + parts.join("｜") : "");
}

function describePage(page: DocxPageInfo): string[] {
  const lines: string[] = ["【页面与分节】"];
  const sizeParts: string[] = [];
  if (page.paper) sizeParts.push(page.paper);
  if (page.widthMm !== undefined && page.heightMm !== undefined) {
    sizeParts.push(page.widthMm.toFixed(1) + " × " + page.heightMm.toFixed(1) + " mm");
  }
  if (page.orientation) sizeParts.push(page.orientation === "landscape" ? "横向" : "纵向");
  if (sizeParts.length > 0) lines.push("- 纸张：" + sizeParts.join("，"));

  const margins = page.margins;
  if (margins) {
    const mm = (label: string, value: number | undefined): string | undefined =>
      value === undefined ? undefined : label + " " + value.toFixed(1);
    const marginText = joinParts(
      [
        mm("上", margins.topMm),
        mm("下", margins.bottomMm),
        mm("左", margins.leftMm),
        mm("右", margins.rightMm),
        mm("页眉", margins.headerMm),
        mm("页脚", margins.footerMm),
      ],
      "｜",
    );
    if (marginText) lines.push("- 页边距（mm）：" + marginText);
    if (margins.gutterMm !== undefined && margins.gutterMm !== 0) {
      lines.push("- 装订线：" + margins.gutterMm.toFixed(1) + " mm");
    }
  }

  if (page.columns && page.columns.count !== undefined) {
    const spacing = page.columns.spaceMm !== undefined ? "，栏间距 " + page.columns.spaceMm.toFixed(1) + " mm" : "";
    lines.push("- 分栏：" + page.columns.count + " 栏" + spacing);
  }
  if (page.titlePage) lines.push("- 首页不同（titlePg）：是");

  lines.push("- 共 " + page.sectionCount + " 节" + (page.sectionCount > 1 ? "，以下为第 1 节" : ""));
  const refs = (list: DocxPageRef[], label: string): string | undefined =>
    list.length === 0
      ? undefined
      : label + "：" + list.map((ref) => ref.type + (ref.target ? " → " + ref.target : "")).join("；");
  const headerText = refs(page.headerRefs, "页眉引用");
  const footerText = refs(page.footerRefs, "页脚引用");
  const refLine = joinParts([headerText, footerText], "｜");
  if (refLine) lines.push("- " + refLine);
  return lines;
}

function describeFonts(fonts: DocxFontsInfo): string[] {
  const parts: string[] = [];
  if (fonts.ascii) parts.push("西文 " + fonts.ascii);
  if (fonts.eastAsia) parts.push("中文 " + fonts.eastAsia);
  if (fonts.sizePt !== undefined) parts.push("默认字号 " + formatPt(fonts.sizePt));
  const langs = [fonts.lang, fonts.eastAsiaLang].filter((lang): lang is string => lang !== undefined);
  if (langs.length > 0) parts.push("语言 " + langs.join(" / "));
  const line = joinParts(parts);
  return line ? ["【默认字体】", "- " + line] : [];
}

function describeParagraphs(detail: DocxDetail): string[] {
  const lines: string[] = [
    "【段落（展示 " + detail.paragraphs.length + " / 共 " + detail.paragraphCount + " 段）】",
  ];
  if (detail.paragraphs.length === 0) lines.push("- （没有可展示的正文段落）");
  for (const paragraph of detail.paragraphs) {
    const style = paragraph.styleId ? "[" + paragraph.styleId + "] " : "";
    const numbering =
      paragraph.numbering && (paragraph.numbering.numId !== undefined || paragraph.numbering.level !== undefined)
        ? "（编号 numId=" + (paragraph.numbering.numId ?? "?") + "，级别 " + (paragraph.numbering.level ?? 0) + "）"
        : "";
    lines.push(paragraph.index + 1 + ". " + style + clip(paragraph.text.replace(/\s+/g, " "), MAX_PARAGRAPH_TEXT_CHARS) + numbering);
    const format = joinParts(
      [
        paragraph.alignment ? "对齐 " + (describeAlignment(paragraph.alignment) ?? paragraph.alignment) : undefined,
        describeIndent(paragraph.indent),
        describeSpacing(paragraph.spacing),
      ],
      "｜",
    );
    if (format) lines.push("   格式：" + format);
    const runs = paragraph.runs.map(describeRun).filter((run): run is string => run !== undefined);
    if (runs.length > 0) {
      const plain = paragraph.plainRunCount > 0 ? "（另有 " + paragraph.plainRunCount + " 个无格式 run）" : "";
      lines.push("   runs：" + runs.join("；") + plain);
    }
  }
  if (detail.paragraphsTruncated) {
    lines.push("- …（还有 " + (detail.paragraphCount - detail.paragraphs.length) + " 段未展示，可调大 maxParagraphs，最多 200）");
  }
  return lines;
}

function describeCell(cell: DocxCellInfo): string {
  const markers: string[] = [];
  if (cell.gridSpan !== undefined) markers.push("跨 " + cell.gridSpan + " 列");
  if (cell.verticalMerge === "restart") markers.push("纵向合并·起始");
  else if (cell.verticalMerge === "continue") markers.push("纵向合并·延续");
  if (cell.shading) markers.push("底纹 #" + cell.shading);
  const text = cell.text.replace(/\s+/g, " ").trim();
  const body = text.length > 0 ? text : "（空）";
  return markers.length > 0 ? body + "（" + markers.join("，") + "）" : body;
}

function describeTables(detail: DocxDetail, maxRowsPerTable: number): string[] {
  const lines: string[] = ["【表格（展示 " + detail.tables.length + " / 共 " + detail.tableCount + " 个）】"];
  if (detail.tables.length === 0) lines.push("- （没有表格）");
  for (const table of detail.tables) {
    const meta = joinParts([
      table.styleId ? "样式 " + table.styleId : undefined,
      table.rowCount + " 行 × " + table.columnCount + " 列",
      table.gridColumns.length > 0 ? "网格宽 " + table.gridColumns.join("/") + " twips" : undefined,
      table.width && table.width.percent !== undefined
        ? "表宽 " + table.width.percent + "%"
        : table.width && table.width.twips !== undefined
          ? "表宽 " + table.width.twips + " twips"
          : undefined,
    ]);
    lines.push("表 " + (table.index + 1) + "：" + (meta ?? "（无属性）"));
    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
      const row = table.rows[rowIndex];
      const prefix = "  r" + (rowIndex + 1) + (row.header ? "（表头）" : "") + "：";
      lines.push(prefix + row.cells.map(describeCell).join("｜"));
    }
    if (table.truncated) {
      lines.push(
        "  …（已省略 " + Math.max(0, table.rowCount - table.rows.length) + " 行，可调大 maxRowsPerTable）",
      );
    }
  }
  return lines;
}

function describeHeaders(headers: DocxHeaderFooterInfo[]): string[] {
  if (headers.length === 0) return ["【页眉页脚】", "- （没有页眉/页脚部件）"];
  const lines: string[] = ["【页眉页脚】"];
  for (const part of headers) {
    const label = part.kind === "header" ? "页眉" : "页脚";
    const refs = part.referencedBy.length > 0 ? "被 " + part.referencedBy.join("、") + " 引用" : "未被分节引用";
    const text = part.paragraphs.length > 0 ? part.paragraphs.join(" / ") : "（无文本）";
    lines.push("- " + label + " " + part.part + "（" + refs + "，共 " + part.paragraphCount + " 段）：" + clip(text, 200));
  }
  return lines;
}

function describeMetadata(metadata: DocxMetadataInfo): string[] {
  const parts = joinParts([
    metadata.title ? "标题 " + metadata.title : undefined,
    metadata.creator ? "作者 " + metadata.creator : undefined,
    metadata.lastModifiedBy ? "最后修改者 " + metadata.lastModifiedBy : undefined,
    metadata.subject ? "主题 " + metadata.subject : undefined,
    metadata.keywords ? "关键词 " + metadata.keywords : undefined,
    metadata.modified ? "修改时间 " + metadata.modified : undefined,
  ]);
  return parts ? ["【文档属性】", "- " + parts] : [];
}

/**
 * Renders the model-readable Chinese summary (markdown-ish plain text).
 *
 * Only the focused blocks are rendered; the header line and the counts line are
 * always present. Output is clipped to maxChars with an explicit hint so the
 * model knows how to get a smaller view (narrow focus / lower max* limits).
 */
export function renderDocxDetailText(detail: DocxDetail, options: DocxDetailRenderOptions = {}): string {
  const focus = resolveFocus(options.focus ?? detail.focus);
  const name = (options.name ?? "").trim() || "（未命名文档）";
  const lines: string[] = [];
  lines.push("Word 文档拆解：" + name + "（" + formatBytes(detail.byteLength) + "）");

  const stats: string[] = [
    "段落 " + detail.paragraphCount + " 段（展示 " + detail.paragraphs.length + "）",
    "表格 " + detail.tableCount + " 个（展示 " + detail.tables.length + "）",
    "样式 " + detail.styleCount + " 个",
  ];
  if (detail.stats.fontSizeSet.length > 0) {
    stats.push("字号 " + detail.stats.fontSizeSet.map(formatPt).join(" / "));
  }
  lines.push("统计：" + stats.join("｜"));

  if (focus.includes("page")) lines.push(...describePage(detail.page));
  if (focus.includes("fonts")) lines.push(...describeFonts(detail.fonts));
  if (focus.includes("styles")) {
    const styleLines = ["【样式】"];
    const rendered = detail.styles.slice(0, MAX_RENDER_STYLES);
    if (rendered.length === 0) styleLines.push("- （styles.xml 没有段落样式）");
    for (const style of rendered) styleLines.push(describeStyle(style));
    if (detail.styles.length > rendered.length) {
      styleLines.push("- …（还有 " + (detail.styles.length - rendered.length) + " 个样式未展示）");
    }
    lines.push(...styleLines);
  }
  if (focus.includes("paragraphs")) lines.push(...describeParagraphs(detail));
  if (focus.includes("tables")) lines.push(...describeTables(detail, DEFAULT_MAX_ROWS_PER_TABLE));
  if (focus.includes("headers")) lines.push(...describeHeaders(detail.headers));
  if (focus.includes("metadata") && detail.metadata) lines.push(...describeMetadata(detail.metadata));

  let text = lines.join("\n");
  const maxChars = options.maxChars !== undefined && options.maxChars > 0 ? options.maxChars : DEFAULT_SUMMARY_CHARS;
  if (text.length > maxChars) {
    text =
      text.slice(0, Math.max(0, maxChars - 60)).trimEnd() +
      "\n…（内容过长已截断：可缩小 focus，或降低 maxTables / maxParagraphs 后重试）";
  }
  return text;
}
