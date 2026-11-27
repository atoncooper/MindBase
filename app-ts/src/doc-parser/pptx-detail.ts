import JSZip from "jszip";

/**
 * PowerPoint (.pptx) DETAIL projection: deck size, slide order, per-slide text,
 * tables and shape / picture / chart statistics.
 *
 * Layer: doc-parser (format knowledge only - no HTTP, no repositories, no LLM).
 * It is the structured counterpart of parsePptx in ./index.ts, which only
 * flattens text for import: an agent that has to understand or reproduce a deck
 * also needs slide ORDER (presentation.xml + rels, not file-name sorting),
 * titles, tables and object counts.
 *
 * Why hand-written scanning: the same trade-off as ./docx-detail.ts - no XML
 * dependency is added, DTD / custom entities are never expanded (only the five
 * predefined entities and numeric character references are decoded), and every
 * part is read through zip-bomb guards (entry count, per-entry and total
 * uncompressed size, XML node/part caps) before it is trusted.
 *
 * Contract: a pure function over a Buffer. Failures (empty/oversized file,
 * corrupt zip, missing slides, bomb guards) throw PptxDetailError with a Chinese
 * reason so the caller can hand it to the model. No I/O, no global state.
 */

/** File-size ceiling for one .pptx (same product class as Word import). */
export const MAX_PPTX_BYTES = 20 * 1024 * 1024;
/** Uncompressed ceiling for ONE zip entry (zip-bomb guard). */
export const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;
/** Entry-count ceiling: a real deck has a few hundred parts at most. */
export const MAX_ZIP_ENTRIES = 1000;
/** Total uncompressed ceiling for the whole package. */
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
/** Slide-part ceiling; protects against a package with a huge slide fan-out. */
export const MAX_SLIDES = 200;

const MAX_XML_PART_CHARS = 16 * 1024 * 1024;
const MAX_XML_NODES = 400_000;
const MAX_PARAGRAPHS_PER_SLIDE = 200;
const MAX_PARAGRAPH_CHARS = 500;
const MAX_TITLE_CHARS = 200;
const MAX_TABLES_PER_SLIDE = 5;
const MAX_TABLE_ROWS = 30;
const MAX_TABLE_COLS = 12;
const MAX_CELL_CHARS = 200;

export const DEFAULT_SUMMARY_CHARS = 6000;
export const DEFAULT_MAX_RENDER_SLIDES = 50;
export const HARD_MAX_RENDER_SLIDES = 200;

export interface PptxTableDetail {
  /** First table row (header), when the table has at least one row. */
  headers?: string[];
  /** Remaining rows (header excluded), bounded by the parser caps. */
  rows: string[][];
}

export interface PptxSlideDetail {
  /** 1-based position in presentation order (NOT the slideN part number). */
  index: number;
  /** Text of the title / ctrTitle placeholder, when present. */
  title?: string;
  /** Non-title paragraph texts in document order (table cells excluded). */
  texts: string[];
  tables: PptxTableDetail[];
  shapeCount: number;
  pictureCount: number;
  hasChart: boolean;
}

export interface PptxDetail {
  slideWidthEmu?: number;
  slideHeightEmu?: number;
  slideCount: number;
  slides: PptxSlideDetail[];
}

export interface PptxRenderOptions {
  /** Character budget, default 6000 (hard max 60000). */
  maxChars?: number;
  /** Slides to render, default 50, hard cap 200. */
  maxSlides?: number;
}

/** User-facing parse failure: the message is already a Chinese explanation. */
export class PptxDetailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PptxDetailError";
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
      throw new PptxDetailError("PowerPoint 文档结构过大（XML 节点数超过上限），无法完整解析");
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
    throw new PptxDetailError("PowerPoint 包内部件过多（超过 " + MAX_ZIP_ENTRIES + " 个），已拒绝解析");
  }
  let total = 0;
  for (const name of names) {
    const file = zip.file(name);
    if (!file || file.dir) continue;
    const size = entryUncompressedSize(file);
    if (size === undefined) continue;
    if (size > MAX_ZIP_ENTRY_BYTES) {
      throw new PptxDetailError(
        "PowerPoint 包内单个部件解压后超过 " + Math.round(MAX_ZIP_ENTRY_BYTES / 1024 / 1024) + "MB（疑似压缩炸弹），已拒绝解析",
      );
    }
    total += size;
    if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new PptxDetailError("PowerPoint 包解压后总大小超过上限（疑似压缩炸弹），已拒绝解析");
    }
  }
}

async function readTextPart(zip: JSZip, path: string): Promise<string | undefined> {
  const file = zip.file(path);
  if (!file || file.dir) return undefined;
  const declared = entryUncompressedSize(file);
  if (declared !== undefined && declared > MAX_ZIP_ENTRY_BYTES) {
    throw new PptxDetailError("PowerPoint 包内的 " + path + " 解压后过大，已跳过");
  }
  const data = await file.async("uint8array");
  if (data.byteLength > MAX_ZIP_ENTRY_BYTES) {
    throw new PptxDetailError("PowerPoint 包内的 " + path + " 解压后过大，已跳过");
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  if (text.length > MAX_XML_PART_CHARS) {
    throw new PptxDetailError("PowerPoint 包内的 " + path + " 超过解析上限（16MB 文本）");
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
// Slide order
// ---------------------------------------------------------------------------

interface SlideOrder {
  slideWidthEmu?: number;
  slideHeightEmu?: number;
  paths: string[];
}

function slidePartNumber(path: string): number {
  const match = /slide(\d+)\.xml$/i.exec(path);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Presentation order lives in ppt/presentation.xml sldIdLst, resolved through
 * ppt/_rels/presentation.xml.rels. When the list or rels are missing / broken
 * we fall back to numeric slideN ordering (lexicographic sorting would put
 * slide10 before slide2). Any slide part that was not referenced is appended
 * numerically so no content is silently dropped.
 */
async function resolveSlideOrder(zip: JSZip): Promise<SlideOrder> {
  const rels = await readRelationships(zip, "ppt/_rels/presentation.xml.rels", "ppt");
  const presentationXml = await readTextPart(zip, "ppt/presentation.xml");
  const ordered: string[] = [];
  let slideWidthEmu: number | undefined;
  let slideHeightEmu: number | undefined;

  if (presentationXml !== undefined) {
    const root = parseXml(presentationXml);
    const sldSz = firstDescendant(root, "p:sldSz");
    slideWidthEmu = numAttr(sldSz, "cx");
    slideHeightEmu = numAttr(sldSz, "cy");
    const list = firstDescendant(root, "p:sldIdLst");
    for (const sldId of childElements(list, "p:sldId")) {
      const relId = textAttr(sldId, "r:id");
      const target = relId ? rels.get(relId) : undefined;
      if (!target || !zip.file(target)) continue;
      if (!ordered.includes(target)) ordered.push(target);
    }
  }

  const allParts = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((left, right) => slidePartNumber(left) - slidePartNumber(right));
  const paths = ordered.length > 0 ? [...ordered, ...allParts.filter((path) => !ordered.includes(path))] : allParts;
  const order: SlideOrder = { paths };
  if (slideWidthEmu !== undefined) order.slideWidthEmu = slideWidthEmu;
  if (slideHeightEmu !== undefined) order.slideHeightEmu = slideHeightEmu;
  return order;
}

// ---------------------------------------------------------------------------
// Slide content
// ---------------------------------------------------------------------------

/** Paragraph text of one a:p element: runs joined, breaks/tabs become spaces. */
function paragraphText(paragraph: XmlNode): string {
  let out = "";
  const visit = (node: XmlNode): void => {
    for (const child of node.children) {
      if (child.name === TEXT_NODE) {
        out += child.text;
        continue;
      }
      if (child.name === "a:t") {
        out += nodeText(child);
        continue;
      }
      if (child.name === "a:br" || child.name === "a:tab") {
        out += " ";
        continue;
      }
      visit(child);
    }
  };
  visit(paragraph);
  return out.replace(/\s+/g, " ").trim();
}

/** All non-empty paragraph texts under a shape / cell node. */
function nodeParagraphTexts(node: XmlNode): string[] {
  const out: string[] = [];
  for (const paragraph of descendants(node, "a:p")) {
    const text = paragraphText(paragraph);
    if (text.length > 0) out.push(text);
  }
  return out;
}

function shapeTitleText(shape: XmlNode): string | undefined {
  const joined = nodeParagraphTexts(shape).join(" ").trim();
  return joined.length > 0 ? clipText(joined, MAX_TITLE_CHARS) : undefined;
}

function tableCellText(cell: XmlNode): string {
  return clipText(nodeParagraphTexts(cell).join(" ").trim(), MAX_CELL_CHARS);
}

function parseTable(table: XmlNode): PptxTableDetail {
  const rows: string[][] = [];
  for (const tr of childElements(table, "a:tr")) {
    if (rows.length >= MAX_TABLE_ROWS) break;
    const cells: string[] = [];
    for (const tc of childElements(tr, "a:tc")) {
      if (cells.length >= MAX_TABLE_COLS) break;
      cells.push(tableCellText(tc));
    }
    rows.push(cells);
  }
  if (rows.length === 0) return { rows: [] };
  return { headers: rows[0], rows: rows.slice(1) };
}

function detectChart(spTree: XmlNode): boolean {
  for (const frame of descendants(spTree, "p:graphicFrame")) {
    if (descendants(frame, "c:chart").length > 0) return true;
    for (const data of descendants(frame, "a:graphicData")) {
      const uri = textAttr(data, "uri") ?? "";
      if (/\/chart$/i.test(uri)) return true;
    }
  }
  return false;
}

function placeholderType(shape: XmlNode): string | undefined {
  return textAttr(firstDescendant(shape, "p:ph"), "type");
}

/**
 * Walks the shape tree in document order. Table subtrees are parsed as tables
 * (their cell paragraphs never leak into the text list), the title placeholder
 * is skipped because it is reported separately.
 */
function collectContent(node: XmlNode, titleNode: XmlNode | undefined, slide: PptxSlideDetail): void {
  for (const child of childElements(node)) {
    if (child.name === "a:tbl") {
      if (slide.tables.length < MAX_TABLES_PER_SLIDE) slide.tables.push(parseTable(child));
      continue;
    }
    if (child === titleNode) continue;
    if (child.name === "a:p") {
      if (slide.texts.length >= MAX_PARAGRAPHS_PER_SLIDE) continue;
      const text = clipText(paragraphText(child), MAX_PARAGRAPH_CHARS);
      if (text.length > 0) slide.texts.push(text);
      continue;
    }
    collectContent(child, titleNode, slide);
  }
}

function parseSlide(xml: string, index: number): PptxSlideDetail {
  const root = parseXml(xml);
  const spTree = firstDescendant(root, "p:spTree") ?? root;
  const shapes = descendants(spTree, "p:sp");
  const titleNode = shapes.find((shape) => {
    const type = placeholderType(shape);
    return type === "title" || type === "ctrTitle";
  });
  const slide: PptxSlideDetail = {
    index,
    texts: [],
    tables: [],
    shapeCount: shapes.length,
    pictureCount: descendants(spTree, "p:pic").length,
    hasChart: detectChart(spTree),
  };
  if (titleNode) {
    const title = shapeTitleText(titleNode);
    if (title !== undefined) slide.title = title;
  }
  collectContent(spTree, titleNode, slide);
  return slide;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parses a .pptx package into a structured detail object.
 *
 * Throws PptxDetailError (Chinese message) for every user-facing failure; all
 * caps are applied here so the returned object stays small enough for a model
 * context window.
 */
export async function parsePptxDetail(buffer: Buffer): Promise<PptxDetail> {
  try {
    return await parsePptxDetailInner(buffer);
  } catch (err) {
    if (err instanceof PptxDetailError) throw err;
    throw new PptxDetailError(
      "PowerPoint 文档解析失败（文件可能已损坏或不是有效的 .pptx）：" + (err instanceof Error ? err.message : String(err)),
    );
  }
}

async function parsePptxDetailInner(buffer: Buffer): Promise<PptxDetail> {
  if (buffer.byteLength === 0) throw new PptxDetailError("PowerPoint 文件为空");
  if (buffer.byteLength > MAX_PPTX_BYTES) {
    throw new PptxDetailError(
      "PowerPoint 文件过大（当前 " +
        (buffer.byteLength / 1024 / 1024).toFixed(1) +
        "MB，上限 " +
        Math.round(MAX_PPTX_BYTES / 1024 / 1024) +
        "MB）",
    );
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new PptxDetailError("无法打开 PowerPoint 包（文件可能已损坏或不是有效的 .pptx）");
  }
  assertNoZipBomb(zip);

  const order = await resolveSlideOrder(zip);
  if (order.paths.length === 0) {
    throw new PptxDetailError("PowerPoint 压缩包内没有幻灯片（可能不是 .pptx）");
  }
  if (order.paths.length > MAX_SLIDES) {
    throw new PptxDetailError("幻灯片数量超过上限（" + MAX_SLIDES + " 页），无法完整解析");
  }

  const slides: PptxSlideDetail[] = [];
  for (const path of order.paths) {
    const xml = await readTextPart(zip, path);
    if (xml === undefined) continue;
    slides.push(parseSlide(xml, slides.length + 1));
  }
  if (slides.length === 0) {
    throw new PptxDetailError("PowerPoint 压缩包内没有可解析的幻灯片");
  }

  const detail: PptxDetail = { slideCount: slides.length, slides };
  if (order.slideWidthEmu !== undefined) detail.slideWidthEmu = order.slideWidthEmu;
  if (order.slideHeightEmu !== undefined) detail.slideHeightEmu = order.slideHeightEmu;
  return detail;
}

// ---------------------------------------------------------------------------
// Model-readable summary
// ---------------------------------------------------------------------------

const SUMMARY_TITLE_CHARS = 80;
const SUMMARY_TEXT_CHARS = 140;
const SUMMARY_CELL_CHARS = 40;
const SUMMARY_TABLE_COLUMNS = 8;

function describeSlideSize(width: number, height: number): string {
  const parts: string[] = [width + " × " + height + " EMU"];
  if (height > 0) {
    const ratio = width / height;
    const known: Array<[number, string]> = [
      [16 / 9, "16:9"],
      [16 / 10, "16:10"],
      [4 / 3, "4:3"],
      [3 / 2, "3:2"],
    ];
    for (const [target, label] of known) {
      if (Math.abs(ratio - target) < 0.02) {
        parts.push(label);
        break;
      }
    }
  }
  return parts.join("，");
}

function tableColumnCount(table: PptxTableDetail): number {
  let columns = table.headers ? table.headers.length : 0;
  for (const row of table.rows) columns = Math.max(columns, row.length);
  return columns;
}

function formatTableRow(row: string[], columns: number): string {
  const cells: string[] = [];
  for (let index = 0; index < columns; index += 1) {
    cells.push(clipText(row[index] ?? "", SUMMARY_CELL_CHARS));
  }
  return cells.join(" | ");
}

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

/**
 * Renders the detail as a compact Chinese summary for the model: deck size,
 * then per slide title / object counts / text paragraphs / tables. Bounded by
 * maxChars (default 6000) and maxSlides (default 50) so one tool result cannot
 * flood the context window.
 */
export function renderPptxDetailText(detail: PptxDetail, opts: PptxRenderOptions = {}): string {
  const maxChars = clampInt(opts.maxChars, DEFAULT_SUMMARY_CHARS, 60000);
  const maxSlides = clampInt(opts.maxSlides, DEFAULT_MAX_RENDER_SLIDES, HARD_MAX_RENDER_SLIDES);
  const lines: string[] = ["【PPT 概览】", "- 幻灯片：" + detail.slideCount + " 页"];
  if (detail.slideWidthEmu !== undefined && detail.slideHeightEmu !== undefined) {
    lines.push("- 尺寸：" + describeSlideSize(detail.slideWidthEmu, detail.slideHeightEmu));
  }

  const shown = detail.slides.slice(0, maxSlides);
  for (const slide of shown) {
    lines.push("");
    lines.push("【第 " + slide.index + " 页】" + (slide.title ? " " + clipText(slide.title, SUMMARY_TITLE_CHARS) : ""));
    const stats: string[] = ["形状 " + slide.shapeCount, "图片 " + slide.pictureCount];
    if (slide.tables.length > 0) stats.push("表格 " + slide.tables.length);
    stats.push("图表：" + (slide.hasChart ? "是" : "无"));
    lines.push("- " + stats.join("｜"));

    if (slide.texts.length > 0) {
      lines.push("- 文本：");
      for (const text of slide.texts) lines.push("  - " + clipText(text, SUMMARY_TEXT_CHARS));
    }

    slide.tables.forEach((table, tableIndex) => {
      const columns = Math.min(Math.max(tableColumnCount(table), 1), SUMMARY_TABLE_COLUMNS);
      const rowCount = (table.headers ? 1 : 0) + table.rows.length;
      lines.push("- 表格 " + (tableIndex + 1) + "（" + columns + " 列 × " + rowCount + " 行）：");
      if (table.headers) lines.push("  | " + formatTableRow(table.headers, columns) + " |");
      for (const row of table.rows) lines.push("  | " + formatTableRow(row, columns) + " |");
    });
  }

  if (detail.slides.length > maxSlides) {
    lines.push("", "…（其余 " + (detail.slides.length - maxSlides) + " 页已省略）");
  }
  return finalizeLines(lines, maxChars);
}
