/**
 * Word (.docx) → text/sections: the doc-parser layer's Word entry.
 *
 * Both projections of the format are owned here so no other layer calls mammoth
 * directly:
 *  - `parseDocxText`     → flat structured text (chat attachments, session docs,
 *    quiz-from-document). Uses mammoth's DEFAULT style map: the manuscript map
 *    below would retag Title-styled paragraphs and change this flat output.
 *  - `parseDocxSections` → title + sections for the academic manuscript model
 *    (contract: docs/manuscript-docx.md §2.1): a Title-styled paragraph is the
 *    document title, h1/h2/h3 (and conservative Chinese/numbered plain-text
 *    headings) are section boundaries, everything else is section body.
 *
 * Layer: doc-parser (format knowledge only — no HTTP, no repositories, no LLM).
 * The mirror concern (title + sections → OOXML package) is
 * `src/services/docx-writer.ts`.
 */
import { parseHTML } from "linkedom";
import { htmlToStructuredText } from "./html-text.js";

/** Official docx content type — the only mime the manuscript endpoints accept/return. */
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Whether a filename/mime pair denotes a Word document (extension OR mime is enough). */
export function isDocxFile(fileName: string, mimeType?: string): boolean {
  if (typeof mimeType === "string" && mimeType.trim().toLowerCase() === DOCX_MIME) return true;
  return /\.docx$/i.test((fileName ?? "").trim());
}

/** Result of parsing a .docx: the document title (first heading, when any) and its sections. */
export interface ParsedDocx {
  title?: string;
  sections: Array<{ title: string; content: string }>;
}

// ---------------------------------------------------------------------------
// Flat text projection (attachments / session docs / quiz-from-document)
// ---------------------------------------------------------------------------

/**
 * Parses a .docx into flat structured text: mammoth's HTML conversion
 * (headings/lists/tables) → htmlToStructuredText, so structure survives into
 * chunking. Deliberately keeps mammoth's default style map — see the module
 * header for why the manuscript map is not shared here.
 */
export async function parseDocxText(buffer: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(buffer) });
  return htmlToStructuredText(result.value);
}

// ---------------------------------------------------------------------------
// Section projection (academic manuscript import)
// ---------------------------------------------------------------------------

/**
 * Mammoth style map: the Title paragraph is tagged so it is not mistaken for a
 * section heading, and the localized built-in heading names Word writes for
 * Chinese documents ("标题 1"/"标题 2"/"标题 3") are recognized in addition to
 * mammoth's default English map.
 */
const PARSE_STYLE_MAP = [
  "p[style-name='Title'] => h1.docx-document-title:fresh",
  "p[style-name='title'] => h1.docx-document-title:fresh",
  "p[style-name='标题'] => h1.docx-document-title:fresh",
  "p[style-name='标题 1'] => h1:fresh",
  "p[style-name='标题 2'] => h2:fresh",
  "p[style-name='标题 3'] => h3:fresh",
  "p[style-name='标题1'] => h1:fresh",
  "p[style-name='标题2'] => h2:fresh",
  "p[style-name='标题3'] => h3:fresh",
];

/** Section heading tag → marker used by the walker. Only the three levels are boundaries. */
const HEADING_TAGS: Record<string, number> = { h1: 1, h2: 2, h3: 3 };

/**
 * Plain-text headings (no Word heading style) are accepted up to this length.
 * Longer paragraphs that merely start with "一、"/"第一章" are prose, not titles.
 */
const MAX_PLAIN_HEADING_CHARS = 40;

/**
 * Plain-text section-heading patterns: Word manuscripts often type headings as
 * ordinary paragraphs ("一、引言", "第一章 方法", "1. 实验设置", "（一）、目标")
 * instead of applying a heading style. Only these three common Chinese/numbered
 * forms are recognized, and each requires some title text after the numbering
 * (a bare "第一章" paragraph is prose/noise, not a usable boundary); the guards
 * below keep normal prose from being split.
 */
const PLAIN_HEADING_PATTERNS: readonly RegExp[] = [
  /^[一二三四五六七八九十]+[、.．]\s*\S/,
  /^第[一二三四五六七八九十\d]+[章节部分]\s*\S/,
  /^（?[一二三四五六七八九十\d]+）?\s*[、.]\s*\S/,
];

/**
 * Whether a body paragraph should be treated as a level-2 section heading.
 * Conservative on purpose: at most 40 characters and no sentence-final "。" —
 * a full stop means the paragraph is prose that happens to start with a number.
 */
function isPlainTextHeading(text: string): boolean {
  const value = text.trim();
  if (value.length === 0 || value.length > MAX_PLAIN_HEADING_CHARS) return false;
  if (value.endsWith("。")) return false;
  return PLAIN_HEADING_PATTERNS.some((pattern) => pattern.test(value));
}

/** Minimal structural view of a linkedom element (avoids depending on its full DOM typings). */
interface HtmlElementLike {
  nodeType: number;
  tagName?: string;
  textContent?: string | null;
  getAttribute?: (name: string) => string | null;
  childNodes?: Iterable<HtmlElementLike>;
}

/** Collapses mammoth's HTML whitespace so one Word paragraph maps to one line of section text. */
function elementText(node: HtmlElementLike): string {
  return (node.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Collects heading/paragraph blocks in document order. Headings are boundaries
 * and are not descended into; paragraphs nested in lists/tables still count as
 * body text, which keeps table rows and bullet text from being dropped.
 */
interface DocxBlock {
  /** true for h1/h2/h3, false for a body paragraph */
  heading: boolean;
  /** heading level 1-3 (0 for body paragraphs) */
  level: number;
  text: string;
  /** true when the block is the Title-styled document title, not a section boundary */
  title: boolean;
}

function collectBlocks(root: HtmlElementLike): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  const visit = (node: HtmlElementLike): void => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeType !== 1) continue;
      const tag = (child.tagName ?? "").toLowerCase();
      const level = HEADING_TAGS[tag];
      if (level !== undefined) {
        const className = child.getAttribute?.("class") ?? "";
        blocks.push({ heading: true, level, text: elementText(child), title: /\bdocx-document-title\b/.test(className) });
        continue;
      }
      if (tag === "p") {
        blocks.push({ heading: false, level: 0, text: elementText(child), title: false });
        continue;
      }
      visit(child);
    }
  };
  visit(root);
  return blocks;
}

/**
 * Parses a .docx into sections.
 *
 * Mammoth converts the package to semantic HTML (headings/lists/tables) and a
 * linkedom walk turns it into blocks: h1/h2/h3 start a new section, and plain
 * paragraphs matching a Chinese/numbered heading form (see
 * isPlainTextHeading) count as level-2 boundaries too; the remaining paragraphs
 * are the section body joined with "\n". A Title-styled paragraph (or, failing
 * that, the first level-1 heading) becomes the document title; a document with no
 * headings at all collapses into one section named "正文", so a plain Word file
 * still round-trips instead of losing its text.
 */
export async function parseDocxSections(buffer: Uint8Array): Promise<ParsedDocx> {
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToHtml(
    { buffer: Buffer.from(buffer) },
    { styleMap: PARSE_STYLE_MAP },
  );
  const { document } = parseHTML("<html><body>" + result.value + "</body></html>") as unknown as {
    document: HtmlElementLike;
  };
  const blocks = collectBlocks(document);

  // Title: an explicit Title-styled paragraph wins; otherwise the first level-1
  // heading (contract: 首个一级标题), and undefined when the document has none.
  const titleBlock = blocks.find((block) => block.title && block.text.length > 0);
  const firstH1 = blocks.find((block) => block.heading && block.level === 1 && block.text.length > 0);
  const title = titleBlock?.text ?? firstH1?.text;

  const sections: Array<{ title: string; content: string }> = [];
  let current: { title: string; lines: string[] } | undefined;
  for (const block of blocks) {
    // The Title paragraph is the document title, not a section boundary.
    if (block.title) continue;
    // A styled heading (h1/h2/h3) or a plain-text heading paragraph starts a
    // section; everything else is body text of the current section.
    if (block.heading || isPlainTextHeading(block.text)) {
      if (current) sections.push({ title: current.title, content: current.lines.join("\n") });
      current = { title: block.text, lines: [] };
      continue;
    }
    if (!current) {
      // Leading body text before the first heading still needs a home; a
      // title-styled paragraph was already consumed above.
      if (block.text.length === 0) continue;
      current = { title: "", lines: [] };
    }
    if (block.text.length > 0) current.lines.push(block.text);
  }
  if (current) sections.push({ title: current.title, content: current.lines.join("\n") });

  if (sections.length === 0) {
    // No heading at all: one "正文" section carrying every paragraph.
    const body = blocks
      .filter((block) => !block.heading && !block.title && block.text.length > 0)
      .map((block) => block.text)
      .join("\n");
    return { ...(title !== undefined ? { title } : {}), sections: [{ title: "正文", content: body }] };
  }
  // A section must have a title for the manuscript model; unnamed leading text gets a stable name.
  const named = sections.map((section, index) => ({
    title: section.title.trim().length > 0 ? section.title : "正文" + (index === 0 ? "" : String(index + 1)),
    content: section.content,
  }));
  return { ...(title !== undefined ? { title } : {}), sections: named };
}
