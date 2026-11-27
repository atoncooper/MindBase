// Office document spec for the chat transcript (`kind: "office-document"`).
//
// Generated Word files used to be shown as rendered page screenshots. The
// product moved to a structured, paper-style preview: the
// backend extracts the document into ordered blocks and ships that shape as an
// artifact, so the transcript can render it as a real document without any
// iframe or raw-HTML injection.
//
// Field shapes and limits mirror the server-side contract
// (app-ts/src/artifacts/office-document.ts). This module is the client's last
// line of defense before OfficeDocumentCard renders: a malformed payload
// degrades to the generic artifact preview in chat-message.tsx instead of
// breaking the turn.

export type OfficeDocumentFormat = "docx";

/** Document header metadata; every field is a short display string. */
export interface OfficeDocumentMeta {
  /** Document title, centred at the top of the page (1..200 chars). */
  title?: string;
  /** Subtitle under the title (1..200 chars). */
  subtitle?: string;
  /** Author shown in the byline (1..200 chars). */
  author?: string;
  /** Date shown in the byline (1..200 chars; free-form display string). */
  date?: string;
}

export type OfficeDocumentHeadingLevel = 1 | 2 | 3;

/** One ordered block of the extracted document. */
export type OfficeDocumentBlock =
  | { type: "heading"; level: OfficeDocumentHeadingLevel; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[]; ordered?: boolean }
  | { type: "table"; headers?: string[]; rows: string[][] }
  | { type: "quote"; text: string }
  | { type: "pageBreak" };

export interface OfficeDocumentData {
  /** Spec version stamped by the backend; only v1 is understood. */
  version: 1;
  /** Source format; only docx is produced today. */
  format: OfficeDocumentFormat;
  /** Source file name including its extension (1..200 chars). */
  name: string;
  /** Cloud-drive file id; deep-links to /cloud-drive/<uploadUuid>. */
  uploadUuid?: string;
  meta?: OfficeDocumentMeta;
  /** Ordered content blocks (1..300 after the backend truncation cap). */
  blocks: OfficeDocumentBlock[];
  /** True when the backend dropped blocks beyond its per-document cap. */
  truncated?: boolean;
}

const OFFICE_DOCUMENT_NAME_MAX = 200;
const OFFICE_DOCUMENT_UPLOAD_UUID_MAX = 256;
const OFFICE_DOCUMENT_META_FIELD_MAX = 200;
const OFFICE_DOCUMENT_BLOCKS_MAX = 300;
const OFFICE_DOCUMENT_TEXT_MAX = 4000;
const OFFICE_DOCUMENT_BULLET_ITEMS_MAX = 100;
const OFFICE_DOCUMENT_BULLET_ITEM_MAX = 1000;
const OFFICE_DOCUMENT_TABLE_COLUMNS_MAX = 10;
const OFFICE_DOCUMENT_TABLE_ROWS_MAX = 200;
const OFFICE_DOCUMENT_TABLE_CELL_MAX = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Any string within the bound (empty display text is tolerated). */
function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isOptionalNonEmptyString(value: unknown, maxLength: number): boolean {
  return value === undefined || (isNonEmptyString(value) && value.length <= maxLength);
}

/** Only present meta fields are validated; all four are optional. */
function isOfficeDocumentMeta(value: unknown): value is OfficeDocumentMeta {
  if (!isRecord(value)) return false;
  return (
    isOptionalNonEmptyString(value.title, OFFICE_DOCUMENT_META_FIELD_MAX) &&
    isOptionalNonEmptyString(value.subtitle, OFFICE_DOCUMENT_META_FIELD_MAX) &&
    isOptionalNonEmptyString(value.author, OFFICE_DOCUMENT_META_FIELD_MAX) &&
    isOptionalNonEmptyString(value.date, OFFICE_DOCUMENT_META_FIELD_MAX)
  );
}

function isTableCellRow(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0 || value.length > OFFICE_DOCUMENT_TABLE_COLUMNS_MAX) return false;
  return value.every((cell) => isBoundedString(cell, OFFICE_DOCUMENT_TABLE_CELL_MAX));
}

function isOfficeDocumentBlock(value: unknown): value is OfficeDocumentBlock {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "heading":
      return (
        (value.level === 1 || value.level === 2 || value.level === 3) &&
        isBoundedString(value.text, OFFICE_DOCUMENT_TEXT_MAX)
      );
    case "paragraph":
    case "quote":
      return isBoundedString(value.text, OFFICE_DOCUMENT_TEXT_MAX);
    case "bullets": {
      const { items, ordered } = value;
      if (
        !Array.isArray(items) ||
        items.length === 0 ||
        items.length > OFFICE_DOCUMENT_BULLET_ITEMS_MAX
      ) {
        return false;
      }
      if (ordered !== undefined && typeof ordered !== "boolean") return false;
      return items.every((item) => isBoundedString(item, OFFICE_DOCUMENT_BULLET_ITEM_MAX));
    }
    case "table": {
      const { headers, rows } = value;
      if (
        !Array.isArray(rows) ||
        rows.length === 0 ||
        rows.length > OFFICE_DOCUMENT_TABLE_ROWS_MAX
      ) {
        return false;
      }
      if (headers !== undefined) {
        if (
          !Array.isArray(headers) ||
          headers.length === 0 ||
          headers.length > OFFICE_DOCUMENT_TABLE_COLUMNS_MAX
        ) {
          return false;
        }
        if (!headers.every((cell) => isBoundedString(cell, OFFICE_DOCUMENT_TABLE_CELL_MAX))) {
          return false;
        }
      }
      // Ragged rows are tolerated (Word tables often omit trailing empties);
      // the renderer pads them to the widest row. Structural limits still apply.
      return rows.every(isTableCellRow);
    }
    case "pageBreak":
      return true;
    default:
      // Unknown block types fail closed so a future/renamed shape never renders
      // as a half-broken document.
      return false;
  }
}

/**
 * Runtime guard for a `kind: "office-document"` artifact payload. Only docx is
 * accepted today; unknown extra fields are tolerated on purpose (the card only
 * renders the fields it understands).
 */
export function isOfficeDocumentData(data: unknown): data is OfficeDocumentData {
  if (!isRecord(data)) return false;

  if (data.version !== 1) return false;
  if (data.format !== "docx") return false;
  if (!isNonEmptyString(data.name) || data.name.length > OFFICE_DOCUMENT_NAME_MAX) return false;
  if (!isOptionalNonEmptyString(data.uploadUuid, OFFICE_DOCUMENT_UPLOAD_UUID_MAX)) return false;
  if (data.truncated !== undefined && typeof data.truncated !== "boolean") return false;
  if (data.meta !== undefined && !isOfficeDocumentMeta(data.meta)) return false;

  if (
    !Array.isArray(data.blocks) ||
    data.blocks.length === 0 ||
    data.blocks.length > OFFICE_DOCUMENT_BLOCKS_MAX
  ) {
    return false;
  }
  return data.blocks.every(isOfficeDocumentBlock);
}
