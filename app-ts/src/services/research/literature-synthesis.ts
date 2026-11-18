/** 文献综述矩阵：由库内条目生成 Markdown 对比表。 */

import type { AcademicLiteratureEntry, AcademicReadingStatus } from "../../repository/academic.js";

/** Chinese display labels for reading progress (shared by the matrix and the tool's get action). */
export const READING_STATUS_LABELS: Record<AcademicReadingStatus, string> = {
  unread: "未读",
  reading: "在读",
  read: "已读",
};

/** Default per-row abstract budget (characters) — long enough for a "要点" cell, short enough for a prompt. */
export const DEFAULT_MATRIX_ABSTRACT_CHARS = 200;

/** Options for buildLiteratureMatrix. */
export interface LiteratureMatrixOptions {
  /** Abstract characters shown per row; default 200. 0 hides abstracts entirely. */
  abstractChars?: number;
}

/** Empty-cell placeholder: missing data is shown as "—", never guessed or filled with fake values. */
const EMPTY_CELL = "—";

/**
 * Reading-status label; an absent legacy value means unread (same default as the
 * contract). Unknown persisted values also fall back to "unread" instead of
 * rendering "undefined" into the matrix.
 */
export function readingStatusLabel(status: AcademicReadingStatus | undefined): string {
  return READING_STATUS_LABELS[status ?? "unread"] ?? READING_STATUS_LABELS.unread;
}

/** Clamp the abstract budget to a non-negative integer, falling back to the default. */
function normalizeAbstractChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MATRIX_ABSTRACT_CHARS;
  return Math.max(0, Math.trunc(value));
}

/** Truncate display text to at most max characters (code-point safe) with a Chinese ellipsis. */
export function truncateText(text: string, max: number): string {
  const chars = Array.from(text.trim());
  if (max <= 0) return "";
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, max).join("") + "…";
}

/**
 * Deterministic display order for the matrix: year ascending (chronology of the
 * field), undated entries last, ties broken by import order and finally citeKey
 * so the same library always renders the same table.
 */
export function sortLiteratureEntries(
  entries: readonly AcademicLiteratureEntry[],
): AcademicLiteratureEntry[] {
  return [...entries].sort((left, right) => {
    const leftYear = left.year ?? Number.POSITIVE_INFINITY;
    const rightYear = right.year ?? Number.POSITIVE_INFINITY;
    if (leftYear !== rightYear) return leftYear - rightYear;
    if (left.importedAt !== right.importedAt) return left.importedAt - right.importedAt;
    if (left.citeKey === right.citeKey) return 0;
    return left.citeKey < right.citeKey ? -1 : 1;
  });
}

/** One Markdown table cell: trim, fold newlines to <br>, escape pipes; blank stays blank. */
function tableCell(value: string): string {
  return value
    .trim()
    .replace(/\r\n|\r|\n/g, "<br>")
    .replace(/\|/g, "\\|");
}

/** Join tags for display: "a、b"; empty tags render as the placeholder. */
function tagsCell(tags: string[] | undefined): string {
  const items = (tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  return items.length > 0 ? tableCell(items.join("、")) : EMPTY_CELL;
}

/** Abstract cell: truncated to the configured budget; an empty abstract renders as the placeholder. */
function abstractCell(abstract: string | undefined, maxChars: number): string {
  const text = (abstract ?? "").trim();
  if (!text) return EMPTY_CELL;
  const truncated = truncateText(text, maxChars);
  return truncated ? tableCell(truncated) : EMPTY_CELL;
}

/**
 * Build the review/comparison matrix as a Markdown table.
 *
 * Columns: citeKey / 标题 / 年份 / 期刊·会议 / 核验 / 阅读状态 / 标签 / 摘要要点.
 * Entries are ordered by sortLiteratureEntries (year ascending, undated last).
 * An empty library returns "" so the caller can emit operation guidance instead
 * of an empty table.
 */
export function buildLiteratureMatrix(
  entries: readonly AcademicLiteratureEntry[],
  opts: LiteratureMatrixOptions = {},
): string {
  if (entries.length === 0) return "";
  const abstractChars = normalizeAbstractChars(opts.abstractChars);
  const header = "| citeKey | 标题 | 年份 | 期刊/会议 | 核验 | 阅读状态 | 标签 | 摘要要点 |";
  const separator = "|---|---|---|---|---|---|---|---|";
  const rows = sortLiteratureEntries(entries).map((entry) => {
    const cells = [
      tableCell(entry.citeKey),
      tableCell(entry.title) || "（无标题）",
      entry.year ? String(entry.year) : EMPTY_CELL,
      (entry.venue ?? "").trim() ? tableCell(entry.venue ?? "") : EMPTY_CELL,
      entry.verified ? "已核验" : "未核验",
      readingStatusLabel(entry.readingStatus),
      tagsCell(entry.tags),
      abstractCell(entry.abstract, abstractChars),
    ];
    return "| " + cells.join(" | ") + " |";
  });
  return [header, separator, ...rows].join("\n");
}
