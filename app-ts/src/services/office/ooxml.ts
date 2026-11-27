/**
 * Shared primitives for the hand-authored OOXML packages (docx / xlsx / pptx).
 *
 * The project deliberately builds Office files from jszip + XML strings instead
 * of pulling a generator dependency: app-ts runs straight from TypeScript
 * (`tsx`) with no bundler step, the docx writer already works this way, and the
 * sandbox image has no office libraries. Keeping one small XML layer here means
 * the three builders never re-implement escaping, inline markup or names.
 */

import { OFFICE_LIMITS } from "./types.js";
import type { InlineRun } from "./types.js";

/** XML declaration shared by every authored part. */
export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/**
 * XML text escaping. Control characters that are illegal in XML 1.0 are dropped
 * (Word/PowerPoint reject the whole part otherwise), tabs become spaces so
 * authored text cannot smuggle in unexpected whitespace semantics.
 */
export function xmlEscape(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\t/g, "    ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Longest text field accepted anywhere (hard cap, applied silently). */
export function clampText(text: string, max = OFFICE_LIMITS.textChars): string {
  const value = text ?? "";
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Inline markup parser: `**bold**`, `*italic*` and ```code```.
 *
 * Only these three forms are recognised — the model writes Markdown-ish text and
 * we render emphasis instead of leaking asterisks into the document. Unmatched
 * markers stay literal, so a stray asterisk never swallows the rest of a line.
 */
export function parseInline(input: string): InlineRun[] {
  const text = clampText(input);
  const runs: InlineRun[] = [];
  let buffer = "";
  let i = 0;
  const flush = () => {
    if (buffer) {
      runs.push({ text: buffer });
      buffer = "";
    }
  };
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith("**")) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        runs.push({ text: text.slice(i + 2, end), bold: true });
        i = end + 2;
        continue;
      }
    }
    if (rest.startsWith("`")) {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        runs.push({ text: text.slice(i + 1, end), code: true });
        i = end + 1;
        continue;
      }
    }
    if (rest.startsWith("*")) {
      const end = text.indexOf("*", i + 1);
      if (end > i + 1 && !text.slice(i + 1, end).includes("\n")) {
        flush();
        runs.push({ text: text.slice(i + 1, end), italic: true });
        i = end + 1;
        continue;
      }
    }
    const ch = text[i];
    if (ch === "\n") {
      flush();
      runs.push({ text: "\n" });
      i += 1;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return runs;
}

/** Plain text of an inline-marked string (titles, file names, table cells). */
export function stripInline(input: string): string {
  return parseInline(input)
    .map((run) => run.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

const FILE_NAME_ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Filesystem-safe file base name (also safe inside `?name=` upload params). */
export function safeFileStem(input: string, fallback = "未命名"): string {
  const cleaned = stripInline(input)
    .replace(FILE_NAME_ILLEGAL, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "");
  const bounded = cleaned.slice(0, 60).trim();
  return bounded === "" ? fallback : bounded;
}

/** `20261125-2010` in the product timezone; stable and sortable in the cloud drive. */
export function fileStamp(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const hour = pick("hour") === "24" ? "00" : pick("hour");
    return `${pick("year")}${pick("month")}${pick("day")}-${hour}${pick("minute")}`;
  } catch {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
  }
}

/** 0-based column index → spreadsheet letters (0 = A, 26 = AA). */
export function columnLetter(index: number): string {
  let value = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (value % 26)) + out;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return out;
}

/** Spreadsheet absolute cell reference, e.g. (0,0) → "A1". */
export function cellRef(row: number, col: number): string {
  return columnLetter(col) + String(row + 1);
}
