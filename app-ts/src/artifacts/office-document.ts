import type { Artifact } from "../context/types.js";

/**
 * Word document preview artifact (kind = "office-document").
 *
 * The transcript shows generated documents as a readable, paper-like page
 * instead of a screenshot: the backend already has the structured blocks the
 * document was built from (or parses them out of an uploaded .docx), and the
 * web client renders them with the same typography rules as the OOXML writer.
 * No binary rides the stream; the download stays a separate file card.
 *
 * Keep the field names/limits in sync with
 * frontendv2/lib/artifacts/office-document-spec.ts (the renderer guard).
 */

export const OFFICE_DOCUMENT_KIND = "office-document";
export const SPEC_VERSION = 1;
export const MAX_BLOCKS = 300;
export const MAX_NAME_CHARS = 200;
export const MAX_TEXT_CHARS = 20_000;
export const MAX_HEADING_CHARS = 300;
export const MAX_LIST_ITEMS = 100;
export const MAX_TABLE_ROWS = 200;
export const MAX_TABLE_COLS = 10;
export const MAX_CELL_CHARS = 2_000;
export const MAX_META_CHARS = 120;
export const MAX_UPLOAD_UUID_CHARS = 200;

export type OfficeDocBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[]; ordered?: boolean }
  | { type: "table"; headers?: string[]; rows: string[][] }
  | { type: "quote"; text: string }
  | { type: "pageBreak" };

export interface OfficeDocumentMeta {
  title?: string;
  subtitle?: string;
  author?: string;
  date?: string;
}

export interface OfficeDocumentData {
  version: number;
  format: "docx";
  /** File name as exported/stored (shown in the card header). */
  name: string;
  /** Cloud-drive id when the document is downloadable from the drive. */
  uploadUuid?: string;
  meta?: OfficeDocumentMeta;
  blocks: OfficeDocBlock[];
  /** true when the source document was longer than the preview cap. */
  truncated?: boolean;
}

export type OfficeDocumentBuildResult = { ok: true; artifact: Artifact } | { ok: false; error: string };

function bad(error: string): OfficeDocumentBuildResult {
  return { ok: false, error };
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  if (text === "") return undefined;
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function normalizeBlock(block: unknown): OfficeDocBlock | undefined {
  if (!block || typeof block !== "object") return undefined;
  const raw = block as Record<string, unknown>;
  switch (raw.type) {
    case "heading": {
      const text = cleanText(raw.text, MAX_HEADING_CHARS);
      if (!text) return undefined;
      const level = raw.level === 2 ? 2 : raw.level === 3 ? 3 : 1;
      return { type: "heading", level, text };
    }
    case "paragraph": {
      const text = cleanText(raw.text, MAX_TEXT_CHARS);
      return text ? { type: "paragraph", text } : undefined;
    }
    case "bullets": {
      const items = Array.isArray(raw.items)
        ? raw.items
            .map((item) => cleanText(item, MAX_CELL_CHARS))
            .filter((item): item is string => item !== undefined)
            .slice(0, MAX_LIST_ITEMS)
        : [];
      if (items.length === 0) return undefined;
      return { type: "bullets", items, ...(raw.ordered === true ? { ordered: true } : {}) };
    }
    case "table": {
      const rows = Array.isArray(raw.rows)
        ? raw.rows
            .filter((row): row is unknown[] => Array.isArray(row))
            .slice(0, MAX_TABLE_ROWS)
            .map((row) =>
              row.slice(0, MAX_TABLE_COLS).map((cell) => (cell === null || cell === undefined ? "" : cleanText(String(cell), MAX_CELL_CHARS) ?? "")),
            )
        : [];
      if (rows.length === 0) return undefined;
      const headers = Array.isArray(raw.headers)
        ? raw.headers
            .slice(0, MAX_TABLE_COLS)
            .map((cell) => cleanText(cell, MAX_CELL_CHARS) ?? "")
        : undefined;
      return { type: "table", ...(headers && headers.length > 0 ? { headers } : {}), rows };
    }
    case "quote": {
      const text = cleanText(raw.text, MAX_TEXT_CHARS);
      return text ? { type: "quote", text } : undefined;
    }
    case "pageBreak":
      return { type: "pageBreak" };
    default:
      return undefined;
  }
}

/** Validates and wraps a document preview as a kind="office-document" artifact. */
export function buildOfficeDocumentArtifact(input: {
  name: string;
  format?: string;
  uploadUuid?: string;
  meta?: OfficeDocumentMeta;
  blocks: unknown[];
  truncated?: boolean;
}): OfficeDocumentBuildResult {
  const name = (input.name ?? "").trim();
  if (name === "" || name.length > MAX_NAME_CHARS) return bad("文件名不合法");
  if (input.format !== undefined && input.format !== "docx") return bad("暂只支持 Word 文档预览");
  if (!Array.isArray(input.blocks)) return bad("缺少文档内容");

  const blocks: OfficeDocBlock[] = [];
  for (const block of input.blocks) {
    const normalized = normalizeBlock(block);
    if (!normalized) continue;
    blocks.push(normalized);
    if (blocks.length >= MAX_BLOCKS) break;
  }
  if (blocks.length === 0) return bad("文档没有可展示的内容");

  const meta: OfficeDocumentMeta = {};
  const title = cleanText(input.meta?.title, MAX_META_CHARS);
  if (title) meta.title = title;
  const subtitle = cleanText(input.meta?.subtitle, MAX_META_CHARS);
  if (subtitle) meta.subtitle = subtitle;
  const author = cleanText(input.meta?.author, MAX_META_CHARS);
  if (author) meta.author = author;
  const date = cleanText(input.meta?.date, MAX_META_CHARS);
  if (date) meta.date = date;

  const uploadUuid = typeof input.uploadUuid === "string" ? input.uploadUuid.trim() : undefined;
  const data: OfficeDocumentData = {
    version: SPEC_VERSION,
    format: "docx",
    name,
    ...(uploadUuid && uploadUuid.length <= MAX_UPLOAD_UUID_CHARS ? { uploadUuid } : {}),
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
    blocks,
    ...(input.truncated === true || blocks.length >= MAX_BLOCKS ? { truncated: true } : {}),
  };
  return { ok: true, artifact: { kind: OFFICE_DOCUMENT_KIND, data } };
}
