import JSZip from "jszip";

import { MAX_BLOCKS, type OfficeDocBlock } from "../artifacts/office-document.js";
import {
  parseDocxDetail,
  type DocxDetail,
  type DocxParagraphInfo,
  type DocxStyleInfo,
  type DocxTableInfo,
} from "./docx-detail.js";

/**
 * .docx -> preview blocks (the structured payload the web client renders as a
 * document page). Sibling of docx-detail.ts: that module answers "how is this
 * document formatted", this one answers "what does it read like, in order".
 *
 * Ordering comes from detail.bodyOrder (the parser records paragraphs and
 * tables as it walks the body), so a table stays exactly where the author put
 * it instead of being appended after the text.
 */

export interface DocxDocumentPreview {
  blocks: OfficeDocBlock[];
  title?: string;
  truncated: boolean;
}

export type DocxPreviewResult =
  | { ok: true; preview: DocxDocumentPreview }
  | { ok: false; error: string };

const ORDERED_FMTS = /decimal|lowerletter|upperletter|lowerroman|upperroman|chinese|ideograph/i;
const LIST_FMTS = /bullet|decimal|lowerletter|upperletter|lowerroman|upperroman|chinese|ideograph|number/i;

function normalizeCellText(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/** numId -> numFmt for level 0, parsed from word/numbering.xml (best effort). */
async function parseNumberingFormats(buffer: Uint8Array): Promise<Map<string, string>> {
  const formats = new Map<string, string>();
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return formats;
  }
  const entry = zip.file("word/numbering.xml");
  if (!entry) return formats;
  const xml = await entry.async("string");

  const abstractFmt = new Map<string, string>();
  for (const match of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[\s\S]*?<\/w:abstractNum>/g)) {
    const block = match[0];
    const level0 = /<w:lvl\b[^>]*w:ilvl="0"[\s\S]*?<w:numFmt w:val="([^"]+)"/.exec(block)?.[1];
    if (level0) abstractFmt.set(match[1], level0);
  }
  for (const match of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[\s\S]*?<w:abstractNumId w:val="(\d+)"/g)) {
    const fmt = abstractFmt.get(match[2]);
    if (fmt) formats.set(match[1], fmt);
  }
  return formats;
}

interface StyleLookup {
  byId: Map<string, DocxStyleInfo>;
}

function headingLevel(styleId: string | undefined, styles: StyleLookup): 1 | 2 | 3 | undefined {
  if (!styleId) return undefined;
  const style = styles.byId.get(styleId);
  const builtin = (style?.builtin ?? "").toLowerCase();
  const headingMatch = /^heading\s*([1-3])$/.exec(builtin);
  if (headingMatch) return Number(headingMatch[1]) as 1 | 2 | 3;
  const name = (style?.name ?? styleId).toLowerCase();
  const nameMatch = /heading\s*([1-3])/.exec(name);
  if (nameMatch) return Number(nameMatch[1]) as 1 | 2 | 3;
  const cnMatch = /标题\s*([1-3一二三])/.exec(name);
  if (cnMatch) {
    const map: Record<string, 1 | 2 | 3> = { "1": 1, "2": 2, "3": 3, "一": 1, "二": 2, "三": 3 };
    return map[cnMatch[1]];
  }
  if (style?.outlineLevel !== undefined && style.outlineLevel >= 0 && style.outlineLevel <= 2) {
    return (style.outlineLevel + 1) as 1 | 2 | 3;
  }
  return undefined;
}

function isTitleStyle(styleId: string | undefined, styles: StyleLookup): boolean {
  if (!styleId) return false;
  const style = styles.byId.get(styleId);
  const builtin = (style?.builtin ?? "").toLowerCase();
  if (builtin === "title") return true;
  const name = (style?.name ?? "").toLowerCase();
  return name === "title" || name === "标题";
}

function tableToBlock(table: DocxTableInfo): OfficeDocBlock | undefined {
  const rows = table.rows.map((row) => row.cells.map((cell) => normalizeCellText(cell.text)));
  if (rows.length === 0) return undefined;
  const hasHeader = table.rows[0]?.header === true;
  const headers = hasHeader ? rows[0] : undefined;
  const dataRows = hasHeader ? rows.slice(1) : rows;
  if (dataRows.length === 0 && !headers) return undefined;
  return {
    type: "table",
    ...(headers ? { headers } : {}),
    rows: dataRows,
  };
}

/** Pure mapping used by both the parser and tests. */
export function docxDetailToPreview(
  detail: DocxDetail,
  numbering: Map<string, string> = new Map(),
): DocxDocumentPreview {
  const styles: StyleLookup = { byId: new Map(detail.styles.map((style) => [style.styleId, style])) };
  const paragraphs = new Map<number, DocxParagraphInfo>(detail.paragraphs.map((paragraph) => [paragraph.index, paragraph]));
  const tables = new Map<number, DocxTableInfo>(detail.tables.map((table) => [table.index, table]));

  const blocks: OfficeDocBlock[] = [];
  let title: string | undefined = detail.metadata?.title?.trim() || undefined;
  let listBuffer: { items: string[]; ordered: boolean; numId: string } | undefined;

  const flushList = () => {
    if (!listBuffer) return;
    if (listBuffer.items.length > 0) {
      blocks.push({ type: "bullets", items: listBuffer.items, ...(listBuffer.ordered ? { ordered: true } : {}) });
    }
    listBuffer = undefined;
  };

  for (const entry of detail.bodyOrder ?? []) {
    if (blocks.length >= MAX_BLOCKS) break;
    if (entry.kind === "table") {
      flushList();
      const table = tables.get(entry.index);
      const block = table ? tableToBlock(table) : undefined;
      if (block) blocks.push(block);
      continue;
    }
    const paragraph = paragraphs.get(entry.index);
    if (!paragraph) continue;
    const text = paragraph.text.trim();
    if (text === "") continue;

    if (!title && isTitleStyle(paragraph.styleId, styles)) {
      title = text;
      continue;
    }
    const level = headingLevel(paragraph.styleId, styles);
    if (level) {
      flushList();
      blocks.push({ type: "heading", level, text });
      continue;
    }
    const numId = paragraph.numbering?.numId;
    const fmt = numId !== undefined ? numbering.get(numId) : undefined;
    if (numId !== undefined && fmt !== undefined && LIST_FMTS.test(fmt)) {
      const ordered = ORDERED_FMTS.test(fmt);
      if (listBuffer && listBuffer.numId === numId && listBuffer.ordered === ordered) {
        listBuffer.items.push(text);
      } else {
        flushList();
        listBuffer = { items: [text], ordered, numId };
      }
      continue;
    }
    flushList();
    blocks.push({ type: "paragraph", text });
  }
  flushList();

  const truncated =
    detail.paragraphsTruncated ||
    detail.tables.some((table) => table.truncated) ||
    blocks.length >= MAX_BLOCKS;
  return {
    blocks: blocks.slice(0, MAX_BLOCKS),
    ...(title ? { title } : {}),
    truncated,
  };
}

/** Parses an uploaded .docx into preview blocks (bounded by the artifact caps). */
export async function parseDocxDocumentPreview(buffer: Uint8Array): Promise<DocxPreviewResult> {
  const parsed = await parseDocxDetail(buffer, {
    maxParagraphs: 200,
    maxTables: 20,
    maxRowsPerTable: 100,
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  let numbering = new Map<string, string>();
  try {
    numbering = await parseNumberingFormats(buffer);
  } catch {
    /* numbering is decorative: preview without real bullets rather than fail */
  }
  return { ok: true, preview: docxDetailToPreview(parsed.detail, numbering) };
}
