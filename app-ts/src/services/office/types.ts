/**
 * Office export content model (contract: docs/office-export.md).
 *
 * One shared, deliberately small model per format — the agent fills it, the
 * builders turn it into OOXML. Everything is plain data: no functions, no
 * binary payloads, so the tool schema, the builders and the tests all speak the
 * same shapes.
 *
 * Field caps live here (not in the tool) so the builders can also reject
 * programmatic callers that bypass the zod schema.
 */

/** Hard ceilings; the tool schema mirrors them, the builders re-check. */
export const OFFICE_LIMITS = {
  /** characters per single text field (paragraph / bullet / cell) */
  textChars: 10_000,
  /** docx blocks per document */
  docxBlocks: 300,
  /** rows per docx table */
  docxTableRows: 200,
  /** xlsx sheets per workbook */
  xlsxSheets: 6,
  /** xlsx rows per sheet (excluding headers) */
  xlsxRows: 5_000,
  /** xlsx columns per sheet */
  xlsxCols: 40,
  /** pptx slides per deck */
  pptxSlides: 40,
  /** pptx bullets per slide */
  pptxBullets: 14,
  /** pptx table rows */
  pptxTableRows: 30,
  /** bytes of the produced package */
  outputBytes: 24 * 1024 * 1024,
} as const;

/** Inline emphasis understood inside docx paragraphs and pptx bullets. */
export type InlineRun = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

export type DocxBlock =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "paragraph"; text: string }
  | { type: "line"; text: string }
  | { type: "bullets"; items: string[]; ordered?: boolean }
  | { type: "quote"; text: string }
  | { type: "table"; headers?: string[]; rows: string[][]; caption?: string; widths?: number[] }
  | { type: "divider" }
  | { type: "cover"; title: string; subtitle?: string; meta?: string[] }
  | { type: "kv"; items: Array<{ label: string; value: string }>; columns?: 1 | 2 }
  | { type: "metrics"; items: Array<{ label: string; value: string; note?: string }> }
  | { type: "callout"; text: string; title?: string; tone?: "info" | "warning" | "success" }
  | { type: "pageBreak" };

export interface DocxContent {
  /** Legacy block list (converted to Document IR by the service). */
  blocks?: DocxBlock[];
  /** Full Document IR (preferred for designed documents: TOC/images/sections). */
  document?: import("./ir.js").DocumentIR;
  /** Template id or alias (academic/business-plan/work-report/...). */
  template?: string;
  /** Backward-compatible alias of template (report/proposal/resume/brief). */
  layout?: string;
  /** Page margin override (normal | narrow | wide); template pages keep their own. */
  margins?: string;
}

/** A cell value: numbers stay numbers (so formulas/aggregates work), strings are inline text. */
export type SheetCell = string | number | boolean | null;

export interface XlsxSheet {
  name: string;
  /** Optional merged banner row above the header row. */
  title?: string;
  headers?: string[];
  rows: SheetCell[][];
  /** Relative column widths (each 6..80); omitted = auto-sized from content. */
  widths?: number[];
  /** Freeze the header row (default true when headers exist). */
  freezeHeader?: boolean;
  /** Add an autofilter over the data range (default true when headers exist). */
  autoFilter?: boolean;
  /** Render the last data row as a bold total row. */
  totalRow?: boolean;
}

export interface XlsxContent {
  sheets: XlsxSheet[];
}

export interface PptxTable {
  headers?: string[];
  rows: string[][];
  /** Relative column widths; omitted = equal columns. */
  widths?: number[];
}

export interface PptxSlide {
  /** Slide headline (required; the deck's first slide doubles as the cover). */
  title: string;
  /** Cover kicker / section subtitle. */
  subtitle?: string;
  bullets?: string[];
  /** Plain paragraphs rendered above the bullets (no bullet glyph). */
  paragraphs?: string[];
  table?: PptxTable;
  /**
   * Visual variant: title = cover, section = chapter divider, content = bullets,
   * table = data table. Omitted = inferred (first slide title, table when a table
   * is present, otherwise content).
   */
  kind?: "title" | "section" | "content" | "table";
}

export interface PptxContent {
  slides: PptxSlide[];
  /** Small footer line on every content slide (e.g. project name). */
  footer?: string;
}

/** Transport-neutral request handed to OfficeExportService. */
export interface OfficeExportSpec {
  format: "docx" | "xlsx" | "pptx";
  /** Document title; also the base of the file name. */
  title: string;
  docx?: DocxContent;
  /**
   * Existing file to overwrite (same upload_uuid): document iteration writes a
   * new revision of ONE cloud file instead of creating a new timestamped file.
   */
  revisionOf?: string;
  xlsx?: XlsxContent;
  pptx?: PptxContent;
  /**
   * Destination: an existing cloud-drive folder id. Wins over folderPath when
   * both are set. Omitted = the user's agent/ folder (created on demand).
   */
  folderId?: number;
  /** Destination sub-path under agent/, e.g. "2026Q3/周报"; omitted = agent/ itself. */
  folderPath?: string;
}
