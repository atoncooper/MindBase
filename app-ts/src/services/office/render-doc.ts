import { readFileSync } from "node:fs";

import JSZip from "jszip";

import { latexToOmml as latexToOmmlV2 } from "./omml.js";

import { createLogger } from "../../logger.js";
import {
  DOCUMENT_ROOT,
  XML_DECL,
  extractDocumentRoot,
  extractSectPr,
  parseStyleIds,
  readZipText,
  resolveStyleIds,
  type ResolvedStyleIds,
} from "../docx-writer.js";
import {
  collectTocHeadings,
  flattenBlocks,
  type DocumentIR,
  type IRBlock,
  type IRImage,
  type IRSection,
  type PageSetup,
} from "./ir.js";
import { buildDocumentStylesXml, buildNumberingXml, halfPoints } from "./style-system.js";
import { resolvePage, type DocTemplate, type PageSpec } from "./templates.js";

/**
 * DOCX Renderer: Document IR + DocTemplate -> a real Word package.
 *
 * Everything is native OOXML: paragraph/character styles, sections with page
 * setup, running headers/footers, PAGE/NUMPAGES fields, a TOC field with
 * updateFields, native numbering, tables with repeat headers, inline drawings
 * with captions, code blocks and page/section breaks. No spaces, no manual line
 * breaks for layout.
 *
 * Two modes:
 *  - standard: the template drives styles.xml, page geometry and header/footer;
 *  - user template (.docx/.dotx): only word/document.xml is replaced, so the
 *    user's styles, headers/footers, numbering and page setup survive.
 */

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const MATH_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const EMU_PER_CM = 360_000;
const TABLE_WIDTH_TWIPS = 8_300;
const FOOTNOTES_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml";
const ENDNOTES_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml";

const log = createLogger("OFFICE-RENDER");

export interface ImageBytes {
  data: Uint8Array;
  mime: string;
}

export type ImageResolver = (image: IRImage) => Promise<ImageBytes | undefined>;

export type FootnoteRestart = "continuous" | "section";

/**
 * Theme + the v4 renderer extensions. The template registry itself is unchanged
 * (templates.ts owns the built-in specs); callers that want section-level
 * footnote renumbering can set it on the theme object or on the IR.
 */
export type RenderTemplate = DocTemplate & { footnoteRestart?: FootnoteRestart };

/** One static table-of-contents line for the two-pass render API. */
export interface TocEntry {
  level: 1 | 2 | 3;
  text: string;
  page: number;
}

export interface RenderDocumentOptions {
  ir: DocumentIR;
  template: RenderTemplate;
  /** Existing .docx/.dotx package: visual layer comes from the user's file. */
  templatePackage?: Uint8Array;
  /** Required when the IR contains image nodes. */
  resolveImage?: ImageResolver;
  /** Brand logo (from the template registry) drawn on the cover. */
  logo?: ImageBytes;
  /**
   * Two-pass TOC: page numbers resolved by the caller (e.g. a PDF text pass).
   * Omitted = keep the historical empty TOC field that Word fills on update.
   */
  tocEntries?: TocEntry[];
}

interface ImageRel {
  id: string;
  name: string;
  mime: string;
  data: Uint8Array;
}

interface RenderState {
  theme: DocTemplate;
  images: ImageRel[];
  nextImageId: number;
  drawingId: number;
  /** Unique w:bookmark ids (captions carry _RefTbl{n} / _RefFig{n} targets). */
  bookmarkId: number;
  figure: number;
  table: number;
  /** Footnote texts in insertion order; the array index + 1 is the w:footnote id. */
  footnotes: string[];
  /** Endnote texts in insertion order; the array index + 1 is the w:endnote id. */
  endnotes: string[];
  /** Formula blocks rendered so far; bookmarks are _RefEq{n}. */
  formula: number;
  /** Heading bookmarks in document order: headingRefs[n - 1] is the nth heading. */
  headingRefs: string[];
  headingSeq: number;
  /** True once an OMML equation was emitted (a template root may need xmlns:m). */
  ommlUsed: boolean;
  captionNumbering: "continuous" | "chapter";
  /** Optional VML watermark drawn in the running header. */
  watermark?: { text: string; opacity?: number };
  /** Resolved document page geometry (cover bleed + image sizing need the real margins). */
  page: PageSpec & { widthTwips: number; heightTwips: number };
  heading: { h1: number; h2: number; h3: number };
  /** Brand logo drawn on the cover (bytes already resolved). */
  logo?: ImageBytes;
  /** Template package mode: resolved style ids + glyph lists. */
  templateMode?: { styleIds: ResolvedStyleIds };
  warning: string[];
}

// ---------------------------------------------------------------- helpers

function esc(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function run(text: string, rPr = "", preserve = true): string {
  return "<w:r>" + (rPr ? "<w:rPr>" + rPr + "</w:rPr>" : "") + '<w:t xml:space="' + (preserve ? "preserve" : "default") + '">' + esc(text) + "</w:t></w:r>";
}

function field(instr: string, placeholder: string, rPr = ""): string {
  return (
    "<w:r>" + (rPr ? "<w:rPr>" + rPr + "</w:rPr>" : "") + '<w:fldChar w:fldCharType="begin"/></w:r>' +
    "<w:r>" + (rPr ? "<w:rPr>" + rPr + "</w:rPr>" : "") + '<w:instrText xml:space="preserve"> ' + instr + " </w:instrText></w:r>" +
    "<w:r>" + (rPr ? "<w:rPr>" + rPr + "</w:rPr>" : "") + '<w:fldChar w:fldCharType="separate"/></w:r>' +
    run(placeholder, rPr) +
    "<w:r>" + (rPr ? "<w:rPr>" + rPr + "</w:rPr>" : "") + '<w:fldChar w:fldCharType="end"/></w:r>'
  );
}

function para(styleId: string, body: string, pPrExtra = ""): string {
  return "<w:p><w:pPr>" + (styleId ? '<w:pStyle w:val="' + styleId + '"/>' : "") + pPrExtra + "</w:pPr>" + body + "</w:p>";
}

function textPara(styleId: string, text: string, pPrExtra = ""): string {
  return para(styleId, run(text), pPrExtra);
}

function emptyPara(pPrExtra = ""): string {
  return "<w:p><w:pPr>" + pPrExtra + "</w:pPr></w:p>";
}

function pageBreak(): string {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

/** Wraps paragraph content in a named bookmark (cross-reference target). */
function bookmarkXml(state: RenderState, name: string, inner: string): string {
  state.bookmarkId += 1;
  const id = state.bookmarkId;
  return '<w:bookmarkStart w:id="' + id + '" w:name="' + name + '"/>' + inner + '<w:bookmarkEnd w:id="' + id + '"/>';
}

/** Inline footnote mark; the note text lands in word/footnotes.xml. */
function footnoteReferenceXml(state: RenderState, text: string): string {
  state.footnotes.push(text);
  const id = state.footnotes.length;
  return (
    "<w:r><w:rPr><w:rStyle w:val=\"FootnoteReference\"/></w:rPr>" +
    '<w:footnoteReference w:id="' + id + '"/></w:r>'
  );
}

/**
 * word/footnotes.xml: the two Word-required separator notes (-1 separator,
 * 0 continuationSeparator) plus one real note per reference, numbered by id.
 */
function footnotesXml(state: RenderState): string {
  const style = state.templateMode ? "" : '<w:pStyle w:val="FootnoteText"/>';
  const notes = state.footnotes
    .map((text, index) =>
      '<w:footnote w:id="' + (index + 1) + '"><w:p><w:pPr>' + style +
      '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>' +
      '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>' +
      '<w:r><w:t xml:space="preserve"> ' + esc(text) + "</w:t></w:r></w:p></w:footnote>",
    )
    .join("");
  return (
    XML_DECL +
    '<w:footnotes xmlns:w="' + W_NS + '">' +
    '<w:footnote w:type="separator" w:id="-1"><w:p><w:pPr>' +
    '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote>' +
    '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr>' +
    '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
    notes +
    "</w:footnotes>"
  );
}

/** Inline endnote mark; the note text lands in word/endnotes.xml. */
function endnoteReferenceXml(state: RenderState, text: string): string {
  state.endnotes.push(text);
  const id = state.endnotes.length;
  return (
    "<w:r><w:rPr><w:rStyle w:val=\"EndnoteReference\"/></w:rPr>" +
    '<w:endnoteReference w:id="' + id + '"/></w:r>'
  );
}

/**
 * word/endnotes.xml: Word-required separator notes (-1 / 0) plus one real note
 * per reference, numbered by id (ids are global, independent of section restarts).
 */
function endnotesXml(state: RenderState): string {
  const style = state.templateMode ? "" : '<w:pStyle w:val="EndnoteText"/>';
  const notes = state.endnotes
    .map((text, index) =>
      '<w:endnote w:id="' + (index + 1) + '"><w:p><w:pPr>' + style +
      '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>' +
      '<w:r><w:rPr><w:rStyle w:val="EndnoteReference"/></w:rPr><w:endnoteRef/></w:r>' +
      '<w:r><w:t xml:space="preserve"> ' + esc(text) + "</w:t></w:r></w:p></w:endnote>",
    )
    .join("");
  return (
    XML_DECL +
    '<w:endnotes xmlns:w="' + W_NS + '">' +
    '<w:endnote w:type="separator" w:id="-1"><w:p><w:pPr>' +
    '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:endnote>' +
    '<w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr>' +
    '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>' +
    notes +
    "</w:endnotes>"
  );
}

// ------------------------------------------------- cross references & inline tokens

type CrossRefKind = "table" | "figure" | "heading" | "formula";

/** Bookmark target for a cross-reference; headings fall back when not yet seen. */
function crossRefTarget(state: RenderState, kind: CrossRefKind, index: number): string {
  switch (kind) {
    case "table":
      return "_RefTbl" + index;
    case "figure":
      return "_RefFig" + index;
    case "formula":
      return "_RefEq" + index;
    case "heading":
      return state.headingRefs[index - 1] ?? "_RefH1_" + index;
  }
}

function crossRefLabel(kind: CrossRefKind): string {
  return kind === "table" ? "表 " : kind === "figure" ? "图 " : kind === "formula" ? "公式 " : "";
}

/** REF \h field: displays the target number and Ctrl+Click jumps to the bookmark. */
function crossRefField(state: RenderState, kind: CrossRefKind, index: number, prefix: string): string {
  const label = crossRefLabel(kind);
  return (
    (prefix ? run(prefix) : "") +
    (label ? run(label) : "") +
    field("REF " + crossRefTarget(state, kind, index) + " \\h", String(index))
  );
}

interface InlineToken {
  kind: "fn";
  text: string;
}

interface InlineRefToken {
  kind: "ref";
  target: CrossRefKind;
  index: number;
}

function parseInlineToken(body: string): InlineToken | InlineRefToken | undefined {
  const separator = body.indexOf(":");
  if (separator <= 0) return undefined;
  const head = body.slice(0, separator).trim().toLowerCase();
  const value = body.slice(separator + 1);
  if (head === "fn") {
    const text = value.trim();
    return text === "" ? undefined : { kind: "fn", text };
  }
  if (head === "ref") {
    const match = /^(table|figure|heading|formula)\s*:\s*(\d+)$/.exec(value.trim());
    if (!match) return undefined;
    const index = Number(match[2]);
    if (!Number.isInteger(index) || index < 1 || index > 500) return undefined;
    return { kind: "ref", target: match[1] as CrossRefKind, index };
  }
  return undefined;
}

/**
 * Paragraph text -> runs, expanding {{fn:...}} (native footnote mark) and
 * {{ref:kind:n}} (REF \h field) inline tokens. Unparseable tokens stay visible
 * as literal text and are reported at info level instead of being dropped.
 */
function inlineRuns(state: RenderState, text: string, rPr = ""): string {
  const parts: string[] = [];
  let last = 0;
  for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(run(text.slice(last, start), rPr));
    const token = match[0];
    const parsed = parseInlineToken(match[1] ?? "");
    if (parsed?.kind === "fn") {
      parts.push(footnoteReferenceXml(state, parsed.text));
    } else if (parsed?.kind === "ref") {
      parts.push(crossRefField(state, parsed.target, parsed.index, ""));
    } else {
      parts.push(run(token, rPr));
      log.info("[OFFICE-RENDER] unknown inline token kept as text: %s", token);
    }
    last = start + token.length;
  }
  if (last < text.length) parts.push(run(text.slice(last), rPr));
  return parts.join("");
}

function inlinePara(state: RenderState, styleId: string, text: string, pPrExtra = ""): string {
  return para(styleId, inlineRuns(state, text), pPrExtra);
}

/** Caption number: plain SEQ or chapter-scoped STYLEREF+SEQ (e.g. 表 2-1). */
function captionNumberXml(state: RenderState, label: "表" | "图", index: number, bookmarkName: string): string {
  if (state.captionNumbering === "chapter") {
    return bookmarkXml(
      state,
      bookmarkName,
      field("STYLEREF 1 \\s", "1") + run("-") + field("SEQ " + label + " \\* ARABIC \\s 1", String(index)),
    );
  }
  return bookmarkXml(state, bookmarkName, field("SEQ " + label + " \\* ARABIC", String(index)));
}

function dividerXml(theme: DocTemplate): string {
  return (
    "<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"" +
    theme.table.borderColor +
    "\"/></w:pBdr><w:spacing w:before=\"160\" w:after=\"160\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr></w:p>"
  );
}

const CHINESE_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
function chineseNumber(value: number): string {
  if (value <= 10) return value === 10 ? "十" : CHINESE_DIGITS[value] ?? String(value);
  if (value < 20) return "十" + CHINESE_DIGITS[value - 10];
  if (value < 100) {
    const tens = Math.floor(value / 10);
    const ones = value % 10;
    return CHINESE_DIGITS[tens] + "十" + (ones === 0 ? "" : CHINESE_DIGITS[ones]);
  }
  return String(value);
}

/** Strips numbering the model may have typed manually, so the renderer owns numbering. */
function stripHeadingNumber(text: string): string {
  return text
    .replace(/^\s*[一二三四五六七八九十百]+\s*[、.．]\s*/, "")
    .replace(/^\s*[（(]\s*[一二三四五六七八九十百0-9]+\s*[）)]\s*/, "")
    .replace(/^\s*\d+(?:\.\d+)*\s*[、.．]?\s+/, "")
    .replace(/^\s*第[一二三四五六七八九十0-9]+[章节部分]\s*/, "")
    .trim();
}

function headingPrefix(state: RenderState, level: 1 | 2 | 3): string {
  const style = state.theme.numbering.style;
  if (style === "none") return "";
  if (style === "chapter-cn") {
    if (level === 1) return chineseNumber(state.heading.h1) + "、";
    if (level === 2) return "（" + chineseNumber(state.heading.h2) + "）";
    return String(state.heading.h3) + ".";
  }
  if (level === 1) return String(state.heading.h1) + ".";
  if (level === 2) return state.heading.h1 + "." + state.heading.h2 + " ";
  return state.heading.h1 + "." + state.heading.h2 + "." + state.heading.h3 + " ";
}

function headingStyleId(state: RenderState, level: 1 | 2 | 3): string {
  const id = level === 3 ? "Heading3" : level === 2 ? "Heading2" : "Heading1";
  if (!state.templateMode) return id;
  const base = state.templateMode.styleIds;
  return level === 3 ? base.heading3 : level === 2 ? base.heading2 : base.heading1;
}

function normalStyleId(state: RenderState): string {
  return state.templateMode ? state.templateMode.styleIds.normal : "Normal";
}

function titleStyleId(state: RenderState): string {
  return state.templateMode ? state.templateMode.styleIds.title : "Title";
}

function bodyStyleId(state: RenderState, style: "body" | "lead" | "note" | undefined): string {
  if (state.templateMode) return normalStyleId(state);
  if (style === "lead") return "Lead";
  if (style === "note") return "Note";
  return "Normal";
}

// ---------------------------------------------------------------- OMML formulas

/**
 * LaTeX subset -> native OMML (m:oMath). Word renders these as real equations
 * (editable, scalable) instead of math-looking text.
 *
 * Supported: plain text, groups, \frac{a}{b}, \sqrt{x}, ^ / _ scripts and a
 * handful of symbols. Anything else returns undefined so the caller can fall
 * back to the IR's plain-text formula instead of emitting invalid OMML.
 */

const OMML_RUN_RPR = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>';

const OMML_SYMBOLS: Record<string, string> = {
  times: "×",
  cdot: "·",
  pm: "±",
  mp: "∓",
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  neq: "≠",
  ne: "≠",
  approx: "≈",
  equiv: "≡",
  infty: "∞",
  partial: "∂",
  sum: "∑",
  prod: "∏",
  int: "∫",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  Delta: "Δ",
  epsilon: "ε",
  theta: "θ",
  lambda: "λ",
  mu: "μ",
  pi: "π",
  sigma: "σ",
  Sigma: "Σ",
  phi: "φ",
  omega: "ω",
  Omega: "Ω",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  cdots: "⋯",
  ldots: "…",
  dots: "…",
};

function ommlRun(text: string): string {
  return "<m:r>" + OMML_RUN_RPR + '<m:t xml:space="preserve">' + esc(text) + "</m:t></m:r>";
}

class LatexOmmlParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): string | undefined {
    try {
      const xml = this.parseAtoms(false);
      if (this.index < this.source.length) return undefined;
      return xml === "" ? undefined : xml;
    } catch {
      return undefined;
    }
  }

  /** Parses a run of atoms; insideGroup stops at the matching "}". */
  private parseAtoms(insideGroup: boolean): string {
    const atoms: string[] = [];
    let text = "";
    const flush = (): void => {
      if (text !== "") {
        atoms.push(ommlRun(text));
        text = "";
      }
    };
    while (this.index < this.source.length) {
      const ch = this.source[this.index] as string;
      if (ch === "}") {
        if (!insideGroup) throw new Error("unbalanced brace");
        this.index += 1;
        flush();
        return atoms.join("");
      }
      if (ch === "{") {
        this.index += 1;
        flush();
        const group = this.parseAtoms(true);
        if (group === "") throw new Error("empty group");
        atoms.push(group);
        continue;
      }
      if (ch === "\\") {
        flush();
        atoms.push(this.parseCommand());
        continue;
      }
      if (ch === "^" || ch === "_") {
        flush();
        const base = atoms.pop();
        if (base === undefined) throw new Error("script without base");
        atoms.push(this.parseScript(base));
        continue;
      }
      if (/\s/.test(ch)) {
        flush();
        this.index += 1;
        continue;
      }
      text += ch;
      this.index += 1;
    }
    if (insideGroup) throw new Error("missing closing brace");
    flush();
    return atoms.join("");
  }

  /** Consumes ^ / _ markers that follow a base atom. */
  private parseScript(base: string): string {
    let sub: string | undefined;
    let sup: string | undefined;
    let count = 0;
    while (this.index < this.source.length && count < 2) {
      const ch = this.source[this.index] as string;
      if (ch === "^") {
        this.index += 1;
        sup = this.parseArgument();
        count += 1;
        continue;
      }
      if (ch === "_") {
        this.index += 1;
        sub = this.parseArgument();
        count += 1;
        continue;
      }
      break;
    }
    if (sub !== undefined && sup !== undefined) {
      return "<m:sSubSup><m:e>" + base + "</m:e><m:sub>" + sub + "</m:sub><m:sup>" + sup + "</m:sup></m:sSubSup>";
    }
    if (sub !== undefined) return "<m:sSub><m:e>" + base + "</m:e><m:sub>" + sub + "</m:sub></m:sSub>";
    if (sup !== undefined) return "<m:sSup><m:e>" + base + "</m:e><m:sup>" + sup + "</m:sup></m:sSup>";
    return base;
  }

  /** One {group}, one command or one literal character. */
  private parseArgument(): string {
    while (this.index < this.source.length && /\s/.test(this.source[this.index] as string)) this.index += 1;
    if (this.index >= this.source.length) throw new Error("missing argument");
    const ch = this.source[this.index] as string;
    if (ch === "{") {
      this.index += 1;
      const xml = this.parseAtoms(true);
      if (xml === "") throw new Error("empty argument");
      return xml;
    }
    if (ch === "\\") return this.parseCommand();
    if (ch === "}" || ch === "^" || ch === "_") throw new Error("bad argument");
    this.index += 1;
    return ommlRun(ch);
  }

  private parseCommand(): string {
    this.index += 1; // the backslash
    if (this.index >= this.source.length) throw new Error("dangling command");
    const ch = this.source[this.index] as string;
    let name: string;
    if (/[a-zA-Z]/.test(ch)) {
      name = this.readWord();
    } else {
      this.index += 1;
      name = ch;
    }
    switch (name) {
      case "frac": {
        const numerator = this.parseArgument();
        const denominator = this.parseArgument();
        return (
          '<m:f><m:fPr><m:type m:val="bar"/></m:fPr><m:num>' + numerator + "</m:num><m:den>" + denominator + "</m:den></m:f>"
        );
      }
      case "sqrt": {
        const body = this.parseArgument();
        return '<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>' + body + "</m:e></m:rad>";
      }
      case "{":
      case "}":
      case "%":
      case "_":
      case "^":
      case "&":
      case "#":
      case "$":
        return ommlRun(name);
      case ",":
      case ";":
      case ":":
      case "!":
      case " ":
        return ommlRun(" ");
      case "\\":
        throw new Error("line break is not supported");
      default: {
        const symbol = OMML_SYMBOLS[name];
        if (symbol === undefined) throw new Error("unsupported command: " + name);
        return ommlRun(symbol);
      }
    }
  }

  private readWord(): string {
    let name = "";
    while (this.index < this.source.length && /[a-zA-Z]/.test(this.source[this.index] as string)) {
      name += this.source[this.index] as string;
      this.index += 1;
    }
    return name;
  }
}

/** Parses a LaTeX subset into a display m:oMath block; undefined = not supported. */
export function latexToOmml(latex: string): string | undefined {
  const xml = new LatexOmmlParser(latex).parse();
  return xml === undefined ? undefined : "<m:oMath>" + xml + "</m:oMath>";
}

// ---------------------------------------------------------------- images

export interface PixelSize {
  width: number;
  height: number;
}

/** Reads intrinsic pixel size from PNG / JPEG headers (fallback: 4:3). */
export function imageDimensions(data: Uint8Array): PixelSize {
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50) {
    const width = (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
    const height = (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23];
    if (width > 0 && height > 0) return { width, height };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1];
      const length = (data[offset + 2] << 8) | data[offset + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = (data[offset + 5] << 8) | data[offset + 6];
        const width = (data[offset + 7] << 8) | data[offset + 8];
        if (width > 0 && height > 0) return { width, height };
      }
      offset += 2 + length;
    }
  }
  return { width: 4, height: 3 };
}

function imageMime(data: Uint8Array, declared?: string): string {
  if (data[0] === 0x89 && data[1] === 0x50) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data[0] === 0x47 && data[1] === 0x49) return "image/gif";
  return (declared ?? "image/png").toLowerCase();
}

function extForMime(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpeg";
  if (mime.includes("gif")) return "gif";
  return "png";
}

async function embedImage(state: RenderState, image: IRImage, resolve?: ImageResolver): Promise<string> {
  if (!resolve) throw new Error("renderDocument: image block requires resolveImage");
  const resolved = await resolve(image);
  if (!resolved) {
    state.warning.push("图片缺失：" + (image.caption ?? image.uploadUuid ?? image.src ?? ""));
    return textPara(bodyStyleId(state, "note"), "【图片缺失：" + (image.caption ?? image.alt ?? "未提供图片") + "】", '<w:jc w:val="center"/>');
  }
  const mime = imageMime(resolved.data, resolved.mime);
  const ext = extForMime(mime);
  const index = state.images.length + 1;
  const relId = "rIdImg" + index;
  state.images.push({ id: relId, name: "image" + index + "." + ext, mime, data: resolved.data });
  const pixels = imageDimensions(resolved.data);
  const page = state.page;
  const contentWidthCm = (page.widthTwips - page.margins.left - page.margins.right) / 567;
  const maxWidthCm = Math.max(4, contentWidthCm - 1);
  let widthCm = Math.min(image.widthCm ?? Math.min(14, maxWidthCm), maxWidthCm);
  let heightCm = (widthCm * pixels.height) / pixels.width;
  // A tall image must not eat more than 60% of the text column height: shrink
  // the width proportionally instead of letting Word bump it to the next page.
  const contentHeightCm = Math.max(6, (page.heightTwips - page.margins.top - page.margins.bottom) / 567);
  const maxHeightCm = contentHeightCm * 0.6;
  if (heightCm > maxHeightCm) {
    heightCm = maxHeightCm;
    widthCm = (maxHeightCm * pixels.width) / pixels.height;
    state.warning.push("图片过高，已自动缩宽：" + (image.caption ?? image.alt ?? "未命名图片"));
  }
  const cx = Math.round(widthCm * EMU_PER_CM);
  const cy = Math.round(heightCm * EMU_PER_CM);
  state.drawingId += 1;
  const drawingId = state.drawingId;
  const align = image.align === "left" ? "left" : image.align === "right" ? "right" : "center";
  const docPr =
    '<wp:docPr id="' + drawingId + '" name="Picture ' + drawingId + '"' +
    (image.alt ? ' descr="' + esc(image.alt) + '"' : "") +
    "/>";
  // Optional picture outline drawn with DrawingML (a:ln inside pic:spPr).
  const borderXml = image.border
    ? '<a:ln w="' + Math.round(image.border.sizePt * 12700) + '"><a:solidFill><a:srgbClr val="' +
      image.border.color + '"/></a:solidFill></a:ln>'
    : "";
  const graphic =
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    "<pic:pic>" +
    '<pic:nvPicPr><pic:cNvPr id="' + drawingId + '" name="image' + index + '.' + ext + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="' + relId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' + borderXml + '</pic:spPr>' +
    "</pic:pic></a:graphicData></a:graphic>";
  const extent = '<wp:extent cx="' + cx + '" cy="' + cy + '"/>';
  const effectExtent = '<wp:effectExtent l="0" t="0" r="0" b="0"/>';
  // wrap=square/topAndBottom -> floating block (wp:anchor) so text flows around
  // it; inline (default) keeps the historical wp:inline behaviour and ignores
  // the floating-only options (wrapText / distCm / floatAlign).
  const floating = image.wrap === "square" || image.wrap === "topAndBottom";
  const dist = image.distCm;
  const emu = (cm: number | undefined, fallback: number): number =>
    cm === undefined ? fallback : Math.max(0, Math.round(cm * EMU_PER_CM));
  const distT = emu(dist?.top, 0);
  const distB = emu(dist?.bottom, 0);
  const distL = emu(dist?.left, 114300);
  const distR = emu(dist?.right, 114300);
  const floatAlign = image.floatAlign === "left" ? "left" : image.floatAlign === "right" ? "right" : "center";
  const wrapXml =
    image.wrap === "square"
      ? '<wp:wrapSquare wrapText="' + (image.wrapText ?? "bothSides") + '"/>'
      : "<wp:wrapTopAndBottom/>";
  const drawing = floating
    ? "<w:r><w:drawing><wp:anchor" +
      ' distT="' + distT + '" distB="' + distB + '" distL="' + distL + '" distR="' + distR + '"' +
      ' simplePos="0" relativeHeight="' + drawingId + '" behindDoc="0" locked="0"' +
      ' layoutInCell="1" allowOverlap="0">' +
      '<wp:simplePos x="0" y="0"/>' +
      '<wp:positionH relativeFrom="column"><wp:align>' + floatAlign + "</wp:align></wp:positionH>" +
      '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
      extent + effectExtent + wrapXml + docPr + graphic +
      "</wp:anchor></w:drawing></w:r>"
    : "<w:r><w:drawing>" +
      '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
      extent + effectExtent + docPr + graphic +
      "</wp:inline></w:drawing></w:r>";
  const captionAbove = image.captionPosition === "above" && image.caption !== undefined;
  const pPr =
    (image.caption && !captionAbove ? "<w:keepNext/>" : "") +
    (floating ? "" : '<w:jc w:val="' + align + '"/>') +
    '<w:spacing w:before="120" w:after="40" w:line="240" w:lineRule="auto"/>';
  const imagePara = "<w:p><w:pPr>" + pPr + "</w:pPr>" + drawing + "</w:p>";
  if (!image.caption) return imagePara;
  state.figure += 1;
  const label = image.caption.replace(/^图\s*\d+\s*[.、:：]?\s*/, "");
  const captionAlign = image.captionAlign ? '<w:jc w:val="' + image.captionAlign + '"/>' : "";
  // Bookmark wraps only "图 N" so REF displays the number and Ctrl+Click jumps here.
  const captionPara = para(
    "Caption",
    run("图 ") + captionNumberXml(state, "图", state.figure, "_RefFig" + state.figure) + run("  " + label),
    (captionAbove ? "<w:keepNext/>" : "") + captionAlign,
  );
  return captionAbove ? captionPara + imagePara : imagePara + captionPara;
}

// ---------------------------------------------------------------- tables & lists

function columnWidths(block: { widths?: number[]; headers?: string[]; rows: string[][] }, columns: number): number[] {
  const provided = block.widths?.filter((value) => value > 0).slice(0, columns) ?? [];
  if (provided.length === columns) {
    const sum = provided.reduce((a, b) => a + b, 0);
    return provided.map((value) => Math.max(500, Math.round((value / sum) * TABLE_WIDTH_TWIPS)));
  }
  const weights: number[] = Array.from({ length: columns }, () => 6);
  const consider = (text: unknown, index: number): void => {
    if (index >= columns) return;
    const value = text === null || text === undefined ? "" : String(text);
    let width = 0;
    for (const ch of value) width += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
    weights[index] = Math.max(weights[index], Math.min(40, width + 2));
  };
  block.headers?.forEach((cell, index) => consider(cell, index));
  block.rows.slice(0, 50).forEach((row) => row.forEach((cell, index) => consider(cell, index)));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((value) => Math.max(500, Math.round((value / sum) * TABLE_WIDTH_TWIPS)));
}

const WHITE_HAIRLINE = (side: string): string =>
  '<w:' + side + ' w:val="single" w:sz="4" w:space="0" w:color="FFFFFF"/>';

function cell(
  state: RenderState,
  options: {
    width: number;
    styleId: string;
    text?: string;
    fill?: string;
    bold?: boolean;
    color?: string;
    sizePt?: number;
    borders?: { side: string; color: string; size?: number }[];
    align?: "left" | "center" | "right";
    vAlign?: "center" | "top";
  },
): string {
  const tcPr: string[] = ['<w:tcW w:w="' + options.width + '" w:type="dxa"/>'];
  if (options.fill) tcPr.push('<w:shd w:val="clear" w:color="auto" w:fill="' + options.fill + '"/>');
  if (options.borders && options.borders.length > 0) {
    const sides = ["top", "left", "bottom", "right", "insideH", "insideV"];
    tcPr.push(
      "<w:tcBorders>" +
        sides
          .map((side) => {
            const border = options.borders?.find((entry) => entry.side === side);
            if (!border) return WHITE_HAIRLINE(side);
            return '<w:' + side + ' w:val="single" w:sz="' + (border.size ?? 4) + '" w:space="0" w:color="' + border.color + '"/>';
          })
          .join("") +
        "</w:tcBorders>",
    );
  }
  tcPr.push('<w:vAlign w:val="' + (options.vAlign ?? "center") + '"/>');
  const rPr =
    (options.bold ? "<w:b/>" : "") +
    (options.color ? '<w:color w:val="' + options.color + '"/>' : "") +
    (options.sizePt ? '<w:sz w:val="' + halfPoints(options.sizePt) + '"/><w:szCs w:val="' + halfPoints(options.sizePt) + '"/>' : "");
  const text = options.text ?? "";
  const jc = options.align === "center" ? '<w:jc w:val="center"/>' : "";
  return "<w:tc><w:tcPr>" + tcPr.join("") + "</w:tcPr>" + textPara(options.styleId, text, jc) + "</w:tc>";
}

function tableShell(options: {
  widths: number[];
  rowsXml: string;
  borders: { color: string } | "none";
  cellMargin?: { top: number; bottom: number; left: number; right: number };
  align?: "center" | "left";
}): string {
  const borderColor = options.borders === "none" ? undefined : options.borders.color;
  const borders =
    borderColor === undefined
      ? "<w:tblBorders>" + ["top", "left", "bottom", "right", "insideH", "insideV"].map(WHITE_HAIRLINE).join("") + "</w:tblBorders>"
      : "<w:tblBorders>" +
        ["top", "left", "bottom", "right", "insideH", "insideV"]
          .map((side) => '<w:' + side + ' w:val="single" w:sz="4" w:space="0" w:color="' + borderColor + '"/>')
          .join("") +
        "</w:tblBorders>";
  const margin = options.cellMargin ?? { top: 30, bottom: 30, left: 110, right: 110 };
  return (
    "<w:tbl><w:tblPr>" +
    '<w:tblW w:w="' + TABLE_WIDTH_TWIPS + '" w:type="dxa"/>' +
    '<w:jc w:val="' + (options.align ?? "center") + '"/>' +
    borders +
    '<w:tblLayout w:type="fixed"/>' +
    "<w:tblCellMar>" +
    '<w:top w:w="' + margin.top + '" w:type="dxa"/><w:left w:w="' + margin.left + '" w:type="dxa"/>' +
    '<w:bottom w:w="' + margin.bottom + '" w:type="dxa"/><w:right w:w="' + margin.right + '" w:type="dxa"/>' +
    "</w:tblCellMar></w:tblPr>" +
    "<w:tblGrid>" + options.widths.map((width) => '<w:gridCol w:w="' + width + '"/>').join("") + "</w:tblGrid>" +
    options.rowsXml +
    "</w:tbl>"
  );
}

function tableRow(cells: string[], header = false): string {
  const trPr = header
    ? '<w:trPr><w:cantSplit/><w:tblHeader/><w:trHeight w:val="340" w:hRule="atLeast"/></w:trPr>'
    : "<w:trPr><w:cantSplit/></w:trPr>";
  return "<w:tr>" + trPr + cells.join("") + "</w:tr>";
}

function dataTable(state: RenderState, block: Extract<IRBlock, { type: "table" }>): string {
  const theme = state.theme;
  const headers = block.headers ?? [];
  const columns = Math.max(headers.length, ...block.rows.map((row) => row.length), 1);
  const widths = columnWidths(block, columns);
  const styleId = state.templateMode ? normalStyleId(state) : "TableText";
  const sizePt = block.fontSizePt ?? (state.templateMode ? undefined : theme.table.fontSizePt);
  const rows: string[] = [];
  if (headers.length > 0) {
    rows.push(
      tableRow(
        widths.map((width, index) =>
          cell(state, {
            width,
            styleId,
            text: headers[index] ?? "",
            fill: theme.table.headerFill,
            bold: theme.table.headerBold,
            color: theme.table.headerColor,
            ...(sizePt ? { sizePt } : {}),
          }),
        ),
        true,
      ),
    );
  }
  const zebra = block.rows.length >= 4;
  block.rows.forEach((row, rowIndex) => {
    const fill = zebra && rowIndex % 2 === 1 ? "F5F7FB" : undefined;
    rows.push(
      tableRow(
        widths.map((width, index) =>
          cell(state, {
            width,
            styleId,
            text: row[index] ?? "",
            ...(fill ? { fill } : {}),
            ...(sizePt ? { sizePt } : {}),
          }),
        ),
      ),
    );
  });
  let caption = "";
  if (block.caption) {
    state.table += 1;
    const label = block.caption.replace(/^表\s*\d+\s*[.、:：]?\s*/, "");
    // SEQ field + bookmark: Word renumbers captions automatically on
    // insert/delete, and crossReference blocks can REF _RefTbl{n}.
    caption = para(
      "Caption",
      run("表 ") + captionNumberXml(state, "表", state.table, "_RefTbl" + state.table) + run("  " + label),
      '<w:keepNext/>',
    );
  }
  const spacer = emptyPara('<w:spacing w:after="120" w:line="240" w:lineRule="auto"/>');
  return caption + tableShell({ widths, rowsXml: rows.join(""), borders: { color: theme.table.borderColor }, align: block.align ?? "center" }) + spacer;
}

function kvTable(state: RenderState, block: Extract<IRBlock, { type: "kv" }>): string {
  const theme = state.theme;
  const styleLabel = state.templateMode ? normalStyleId(state) : "KvLabel";
  const styleValue = state.templateMode ? normalStyleId(state) : "KvValue";
  const border = [{ side: "bottom", color: "E5E7EB", size: 4 }];
  const rows: string[] = [];
  if ((block.columns ?? 2) === 2) {
    const widths = columnWidths({ widths: [1500, 2600, 1500, 2600], rows: [] }, 4);
    for (let index = 0; index < block.items.length; index += 2) {
      const left = block.items[index];
      const right = block.items[index + 1];
      rows.push(
        tableRow([
          cell(state, { width: widths[0], styleId: styleLabel, text: left?.label ?? "", color: "6B7280", sizePt: Math.min(10, theme.typography.bodySizePt), borders: border }),
          cell(state, { width: widths[1], styleId: styleValue, text: left?.value ?? "", color: "111827", sizePt: theme.typography.bodySizePt, borders: border }),
          cell(state, { width: widths[2], styleId: styleLabel, text: right?.label ?? "", color: "6B7280", sizePt: Math.min(10, theme.typography.bodySizePt), borders: border }),
          cell(state, { width: widths[3], styleId: styleValue, text: right?.value ?? "", color: "111827", sizePt: theme.typography.bodySizePt, borders: border }),
        ]),
      );
    }
    return tableShell({ widths, rowsXml: rows.join(""), borders: "none", cellMargin: { top: 40, bottom: 40, left: 40, right: 120 } }) + emptyPara('<w:spacing w:after="140" w:line="240" w:lineRule="auto"/>');
  }
  const widths = columnWidths({ widths: [1700, 6600], rows: [] }, 2);
  for (const item of block.items) {
    rows.push(
      tableRow([
        cell(state, { width: widths[0], styleId: styleLabel, text: item.label, color: "6B7280", sizePt: Math.min(10, theme.typography.bodySizePt), borders: border }),
        cell(state, { width: widths[1], styleId: styleValue, text: item.value, color: "111827", sizePt: theme.typography.bodySizePt, borders: border }),
      ]),
    );
  }
  return tableShell({ widths, rowsXml: rows.join(""), borders: "none", cellMargin: { top: 40, bottom: 40, left: 40, right: 120 } }) + emptyPara('<w:spacing w:after="140" w:line="240" w:lineRule="auto"/>');
}

function metricsTable(state: RenderState, block: Extract<IRBlock, { type: "metrics" }>): string {
  const theme = state.theme;
  const columns = Math.min(block.items.length, 4);
  const widths = columnWidths({ widths: Array.from({ length: columns }, () => 1), rows: [] }, columns);
  const rows: string[] = [];
  for (let start = 0; start < block.items.length; start += columns) {
    const chunk = block.items.slice(start, start + columns);
    const cells = widths.map((width, index) => {
      const item = chunk[index];
      if (!item) return cell(state, { width, styleId: normalStyleId(state), text: "" });
      const body =
        textPara(state.templateMode ? normalStyleId(state) : "MetricValue", item.value, '<w:ind w:firstLineChars="0" w:firstLine="0"/>') +
        textPara(state.templateMode ? normalStyleId(state) : "MetricLabel", item.label, '<w:ind w:firstLineChars="0" w:firstLine="0"/>') +
        (item.note ? textPara(state.templateMode ? normalStyleId(state) : "MetricNote", item.note, '<w:ind w:firstLineChars="0" w:firstLine="0"/>') : "");
      return (
        "<w:tc><w:tcPr>" +
        '<w:tcW w:w="' + width + '" w:type="dxa"/>' +
        '<w:shd w:val="clear" w:color="auto" w:fill="F7F8FA"/>' +
        "<w:tcBorders>" + ["top", "left", "bottom", "right"].map(WHITE_HAIRLINE).join("") + "</w:tcBorders>" +
        '<w:vAlign w:val="center"/>' +
        "</w:tcPr>" + body + "</w:tc>"
      );
    });
    rows.push(tableRow(cells));
  }
  return tableShell({ widths, rowsXml: rows.join(""), borders: "none", cellMargin: { top: 80, bottom: 80, left: 140, right: 140 } }) + emptyPara('<w:spacing w:after="140" w:line="240" w:lineRule="auto"/>');
}

function callout(state: RenderState, block: Extract<IRBlock, { type: "callout" }>): string {
  const tone = block.tone === "warning" ? "warning" : block.tone === "success" ? "success" : "info";
  const palette =
    tone === "warning"
      ? { bg: "FFFBEB", accent: "D97706" }
      : tone === "success"
        ? { bg: "ECFDF5", accent: "059669" }
        : { bg: "EFF6FF", accent: "3B82F6" };
  const title = block.title
    ? inlinePara(state, state.templateMode ? normalStyleId(state) : "CalloutTitle", block.title)
    : "";
  const text = inlinePara(state, state.templateMode ? normalStyleId(state) : "CalloutText", block.text);
  return (
    tableShell({
      widths: [TABLE_WIDTH_TWIPS],
      borders: "none",
      cellMargin: { top: 120, bottom: 120, left: 200, right: 200 },
      rowsXml: tableRow([
        "<w:tc><w:tcPr>" +
          '<w:tcW w:w="' + TABLE_WIDTH_TWIPS + '" w:type="dxa"/>' +
          '<w:shd w:val="clear" w:color="auto" w:fill="' + palette.bg + '"/>' +
          "<w:tcBorders>" +
          WHITE_HAIRLINE("top") +
          '<w:left w:val="single" w:sz="24" w:space="0" w:color="' + palette.accent + '"/>' +
          WHITE_HAIRLINE("bottom") +
          WHITE_HAIRLINE("right") +
          "</w:tcBorders>" +
          "</w:tcPr>" + title + text + "</w:tc>",
      ]),
    }) + emptyPara('<w:spacing w:after="140" w:line="240" w:lineRule="auto"/>')
  );
}

async function blockXml(state: RenderState, block: IRBlock, resolveImage?: ImageResolver): Promise<string> {
  const theme = state.theme;
  switch (block.type) {
    case "heading": {
      if (block.level === 1) {
        state.heading.h1 += 1;
        state.heading.h2 = 0;
        state.heading.h3 = 0;
      } else if (block.level === 2) {
        state.heading.h2 += 1;
        state.heading.h3 = 0;
      } else {
        state.heading.h3 += 1;
      }
      // Word generates heading numbers from the style numbering (numId 10);
      // strip numbers the model typed so they are not doubled.
      state.headingSeq += 1;
      const bookmarkName = "_RefH" + block.level + "_" + state.headingSeq;
      state.headingRefs.push(bookmarkName);
      return para(
        headingStyleId(state, block.level),
        bookmarkXml(state, bookmarkName, run(stripHeadingNumber(block.text))),
      );
    }
    case "paragraph": {
      const styleId = bodyStyleId(state, block.style);
      const jc = block.align === "center" ? '<w:jc w:val="center"/>' : block.align === "right" ? '<w:jc w:val="right"/>' : block.align === "left" ? '<w:jc w:val="left"/>' : "";
      return inlinePara(state, styleId, block.text.replace(/\n+/g, " "), jc);
    }
    case "line":
      return inlinePara(state, normalStyleId(state), block.text, '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:spacing w:after="60"/>');
    case "orderedList":
    case "unorderedList": {
      const listStyle = state.templateMode ? normalStyleId(state) : "ListParagraph";
      return block.items
        .map((item) =>
          state.templateMode
            ? textPara(normalStyleId(state), "• " + item, '<w:ind w:left="480" w:hanging="240" w:firstLineChars="0" w:firstLine="0"/>')
            : para(listStyle, run(item), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="' + (block.type === "orderedList" ? 2 : 1) + '"/></w:numPr>'),
        )
        .join("");
    }
    case "table":
      return dataTable(state, block);
    case "kv":
      return kvTable(state, block);
    case "metrics":
      return metricsTable(state, block);
    case "callout":
      return callout(state, block);
    case "image":
      return embedImage(state, block, resolveImage);
    case "caption":
      return inlinePara(state, "Caption", block.text);
    case "footnote":
      // Native footnote: the mark belongs to the preceding paragraph's flow, so
      // the assembler appends this run to the last rendered paragraph.
      return footnoteReferenceXml(state, block.text);
    case "endnote":
      // Native endnote: same assembly rule as footnotes, but the text lives in
      // word/endnotes.xml (collected at the end of the document).
      return endnoteReferenceXml(state, block.text);
    case "crossReference":
      // REF \h field: displays the target number and Ctrl+Click jumps to the bookmark.
      return para(bodyStyleId(state, "body"), crossRefField(state, block.kind, block.index, block.prefix ?? "见"));
    case "quote": {
      const cite = block.cite ? textPara("Note", "—— " + block.cite, '<w:jc w:val="right"/>') : "";
      return inlinePara(state, state.templateMode ? normalStyleId(state) : "Quote", block.text) + cite;
    }
    case "codeBlock": {
      const lines = block.code.replace(/\r\n/g, "\n").split("\n");
      return lines
        .map((line) =>
          line === ""
            ? emptyPara('<w:pStyle w:val="CodeBlock"/>')
            : textPara("CodeBlock", line, '<w:ind w:left="120" w:right="120" w:firstLineChars="0" w:firstLine="0"/>'),
        )
        .join("");
    }
    case "formula": {
      state.formula += 1;
      const bookmarkName = "_RefEq" + state.formula;
      const styleId = state.templateMode ? normalStyleId(state) : "Formula";
      const pPr = '<w:jc w:val="center"/><w:ind w:firstLineChars="0" w:firstLine="0"/>';
      const omml = block.latex ? latexToOmmlV2(block.latex) : undefined;
      if (omml) {
        // Template mode also gets native OMML (the package root is patched with
        // xmlns:m when the user's template does not declare it).
        state.ommlUsed = true;
        return para(styleId, bookmarkXml(state, bookmarkName, "<m:oMathPara>" + omml + "</m:oMathPara>"), pPr);
      }
      // Unsupported LaTeX keeps the IR plain-text formula so nothing is dropped.
      return para(styleId, bookmarkXml(state, bookmarkName, run(block.text)), pPr);
    }
    case "reference":
      return block.items.map((item) => textPara(state.templateMode ? normalStyleId(state) : "Reference", item)).join("");
    case "toc":
      return tocXml(theme);
    case "divider":
      return dividerXml(theme);
    case "pageBreak":
      return pageBreak();
    case "sectionBreak":
      return "";
    default:
      return "";
  }
}

/** One static TOC line: heading text, dot leader tab stop and the resolved page. */
function tocEntryXml(entry: TocEntry): string {
  const level = entry.level === 2 ? 2 : entry.level === 3 ? 3 : 1;
  const page = Number.isFinite(entry.page) ? Math.max(0, Math.round(entry.page)) : 0;
  return (
    "<w:p><w:pPr>" +
    '<w:pStyle w:val="TOC' + level + '"/>' +
    '<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="8300"/></w:tabs>' +
    "</w:pPr>" +
    run(entry.text) +
    "<w:r><w:tab/></w:r>" +
    run(String(page)) +
    "</w:p>"
  );
}

/**
 * TOC field + optional static entries. Without entries the field renders empty
 * and Word fills it on update (historical behaviour); with tocEntries the
 * caller-supplied page numbers are written inside the field result (two-pass
 * rendering: render -> extract pages from PDF -> render again).
 */
function tocXml(theme: DocTemplate, entries?: TocEntry[]): string {
  const heading = textPara("TOCHeading", theme.toc.title);
  const begin =
    "<w:p><w:r><w:fldChar w:fldCharType=\"begin\"/></w:r>" +
    '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-' + theme.toc.depth + '" \\h \\z \\u </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
  const note = textPara("Note", "目录会在 Word 打开文档时自动生成；如未显示，请全选后按 F9 更新域。");
  if (!entries || entries.length === 0) {
    return heading + begin + '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' + note + pageBreak();
  }
  return (
    heading +
    begin +
    "</w:p>" +
    entries.map(tocEntryXml).join("") +
    '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
    note +
    pageBreak()
  );
}

/**
 * Cover accent band, full bleed: a shaded paragraph whose left/right indents
 * are the negative page margins, so the colour reaches both paper edges
 * (table-based bands stop at the text column and leave white gutters).
 */
function coverBandXml(state: RenderState, accent: string, align: "left" | "center"): string {
  const page = state.page;
  const left = -Math.max(0, Math.round(page.margins.left));
  const right = -Math.max(0, Math.round(page.margins.right));
  return (
    "<w:p><w:pPr>" +
    '<w:shd w:val="clear" w:color="auto" w:fill="' + accent + '"/>' +
    '<w:ind w:left="' + left + '" w:right="' + right + '" w:firstLineChars="0" w:firstLine="0"/>' +
    '<w:spacing w:before="0" w:after="0" w:line="360" w:lineRule="exact"/>' +
    '<w:jc w:val="' + align + '"/>' +
    '</w:pPr><w:r><w:rPr><w:sz w:val="2"/></w:rPr><w:t xml:space="preserve"> </w:t></w:r></w:p>'
  );
}

/** Draws the brand logo at the top of the cover (width <= 4cm). */
function logoPara(state: RenderState): string {
  const logo = state.logo;
  if (!logo) return "";
  const mime = imageMime(logo.data, logo.mime);
  const ext = extForMime(mime);
  const index = state.images.length + 1;
  const relId = "rIdImg" + index;
  state.images.push({ id: relId, name: "logo" + index + "." + ext, mime, data: logo.data });
  const pixels = imageDimensions(logo.data);
  const page = state.page;
  const contentWidthCm = (page.widthTwips - page.margins.left - page.margins.right) / 567;
  const widthCm = Math.min(4, contentWidthCm - 1);
  const heightCm = Math.max(0.8, (widthCm * pixels.height) / pixels.width);
  const cx = Math.round(widthCm * EMU_PER_CM);
  const cy = Math.round(heightCm * EMU_PER_CM);
  state.drawingId += 1;
  const drawingId = state.drawingId;
  const drawing =
    "<w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">" +
    '<wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:docPr id="' + drawingId + '" name="Logo ' + drawingId + '"/>' +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    "<pic:pic><pic:nvPicPr><pic:cNvPr id=\"" + drawingId + "\" name=\"" + "logo" + index + "." + ext + "\"/><pic:cNvPicPr/></pic:nvPicPr>" +
    '<pic:blipFill><a:blip r:embed="' + relId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>";
  return "<w:p><w:pPr><w:jc w:val=\"center\"/><w:spacing w:before=\"120\" w:after=\"120\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr>" + drawing + "</w:p>";
}

function coverXml(state: RenderState, doc: DocumentIR): string {
  const theme = state.theme;
  const meta = doc.meta ?? {};
  const accent = theme.typography.accentColor;
  const banner = theme.cover.variant === "banner";
  const align = banner ? "left" : "center";
  const org = meta.organization?.trim();
  const bottomMeta = [meta.author, meta.date, meta.docNo].filter(
    (line): line is string => typeof line === "string" && line.trim() !== "",
  );
  const parts: string[] = [];
  if (theme.cover.variant !== "plain") parts.push(coverBandXml(state, accent, align));
  if (state.logo) parts.push(logoPara(state));
  parts.push(emptyPara('<w:spacing w:before="' + theme.cover.spaceBeforeTwips + '" w:after="0" w:line="240" w:lineRule="auto"/>'));
  if (org) parts.push(textPara("CoverMeta", org, '<w:jc w:val="' + align + '"/>'));
  parts.push(emptyPara('<w:spacing w:before="240" w:after="0" w:line="240" w:lineRule="auto"/>'));
  parts.push(textPara("CoverTitle", doc.title));
  if (doc.subtitle) parts.push(textPara("CoverSubtitle", doc.subtitle));
  if (theme.cover.rule) {
    parts.push(
      "<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"8\" w:space=\"4\" w:color=\"" +
        accent +
        "\"/></w:pBdr><w:spacing w:before=\"240\" w:after=\"240\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr></w:p>",
    );
  }
  if (meta.abstract) parts.push(textPara("Note", "摘要：" + meta.abstract));
  parts.push(emptyPara('<w:spacing w:before="' + Math.max(600, theme.cover.spaceBeforeTwips - 600) + '" w:after="0"/>'));
  for (const line of bottomMeta) parts.push(textPara("CoverMeta", line, '<w:jc w:val="' + align + '"/>'));
  for (const extra of doc.coverMeta ?? []) {
    const line = extra.trim();
    if (line) parts.push(textPara("CoverMeta", line, '<w:jc w:val="' + align + '"/>'));
  }
  parts.push(pageBreak());
  return parts.join("");
}

// ---------------------------------------------------------------- page setup / headers

function sectPrXml(
  state: RenderState,
  page: PageSpec & { widthTwips: number; heightTwips: number },
  options: {
    firstPageHeaderFooter: boolean;
    startAtZero: boolean;
    /** Two-column section layout (w:cols). */
    columns?: 1 | 2;
    /** Restart footnote numbering in this section (w:footnotePr/w:numRestart). */
    restartFootnotes?: boolean;
  },
): string {
  const theme = state.theme;
  void theme;
  const headerRefs =
    '<w:headerReference w:type="default" r:id="rId3"/><w:footerReference w:type="default" r:id="rId4"/>' +
    (options.firstPageHeaderFooter ? '<w:headerReference w:type="first" r:id="rId5"/><w:footerReference w:type="first" r:id="rId6"/>' : "") +
    (options.firstPageHeaderFooter ? "<w:titlePg/>" : "") +
    (options.startAtZero ? '<w:pgNumType w:start="0"/>' : "");
  // w:footnotePr must precede the page geometry in the sectPr sequence.
  const footnotePr = options.restartFootnotes
    ? '<w:footnotePr><w:numRestart w:val="eachSect"/></w:footnotePr>'
    : "";
  const columns = options.columns === 2 ? '<w:cols w:num="2" w:space="425"/>' : "";
  return (
    "<w:sectPr>" +
    headerRefs +
    footnotePr +
    '<w:pgSz w:w="' + page.widthTwips + '" w:h="' + page.heightTwips + '"' + (page.orientation === "landscape" ? ' w:orient="landscape"' : "") + "/>" +
    '<w:pgMar w:top="' + page.margins.top + '" w:right="' + page.margins.right + '" w:bottom="' + page.margins.bottom +
    '" w:left="' + page.margins.left + '" w:header="' + page.headerDistance + '" w:footer="' + page.footerDistance + '" w:gutter="0"/>' +
    columns +
    "</w:sectPr>"
  );
}

/**
 * Diagonal VML text watermark (no image part): a v:shape with v:textpath inside
 * w:pict, centred on the page and sent behind the text.
 */
function watermarkXml(watermark: { text: string; opacity?: number }): string {
  const opacity = watermark.opacity === undefined ? 0.5 : watermark.opacity;
  return (
    "<w:p><w:r><w:pict>" +
    '<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e">' +
    '<v:formulas><v:f eqn="sum #0 0 10800"/><v:f eqn="prod #0 2 1"/><v:f eqn="sum 21600 0 @1"/>' +
    '<v:f eqn="sum 0 0 @2"/><v:f eqn="sum 21600 0 @3"/><v:f eqn="if @0 @3 0"/><v:f eqn="if @0 21600 @1"/>' +
    '<v:f eqn="if @0 0 @2"/><v:f eqn="if @0 @4 21600"/><v:f eqn="mid @5 @6"/><v:f eqn="mid @8 @5"/>' +
    '<v:f eqn="mid @7 @8"/><v:f eqn="mid @6 @7"/><v:f eqn="sum @6 0 @5"/></v:formulas>' +
    '<v:path textpathok="t" o:connecttype="custom" o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800" o:connectangles="270,180,90,0"/>' +
    '<v:textpath on="t" fitshape="t"/>' +
    '<v:handles><v:h position="#0,bottomRight" xrange="6629,14971"/></v:handles></v:shapetype>' +
    '<v:shape id="MindBaseWaterMark" o:spid="_x0000_s2049" type="#_x0000_t136" ' +
    'style="position:absolute;margin-left:0;margin-top:0;width:468pt;height:117pt;rotation:315;z-index:-251658752;' +
    'mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin" ' +
    'o:allowincell="f" fillcolor="#C0C0C0" stroked="f">' +
    '<v:fill opacity="' + opacity + '"/>' +
    '<v:textpath style="font-family:&quot;宋体&quot;;font-size:1pt" string="' + esc(watermark.text) + '"/>' +
    "</v:shape></w:pict></w:r></w:p>"
  );
}

function headerXml(state: RenderState, left: string, right: string): string {
  const theme = state.theme;
  const page = theme.page;
  const usable = Math.max(2000, 11906 - page.margins.left - page.margins.right);
  const rule = theme.headerFooter.headerRule
    ? '<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="D9D9D9"/></w:pBdr>'
    : "";
  const tabStop = '<w:tabs><w:tab w:val="right" w:pos="' + usable + '"/></w:tabs>';
  const leftRun = left ? run(left) : "";
  const rightRun = right ? "<w:r><w:tab/></w:r>" + run(right) : "";
  const vmlNs = state.watermark
    ? ' xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"'
    : "";
  return (
    XML_DECL +
    '<w:hdr xmlns:w="' + W_NS + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' + vmlNs + ">" +
    "<w:p><w:pPr>" +
    '<w:pStyle w:val="Header"/><w:jc w:val="left"/>' +
    '<w:ind w:firstLineChars="0" w:firstLine="0"/>' + tabStop + rule +
    "</w:pPr>" + leftRun + rightRun + "</w:p>" +
    (state.watermark ? watermarkXml(state.watermark) : "") +
    "</w:hdr>"
  );
}

function footerXml(state: RenderState, text: string): string {
  const theme = state.theme;
  const jc = theme.headerFooter.pageNumber === "left" ? "left" : theme.headerFooter.pageNumber === "right" ? "right" : "center";
  const total = theme.headerFooter.pageTotal
    ? run(" / 共 ") + field("NUMPAGES", "1") + run(" 页")
    : "";
  // A template extension may also use "chinese" (第 X 页) although the built-in
  // registry type only lists plain/dash.
  const pageNumberFormat = theme.headerFooter.pageNumberFormat as string;
  const pageRun =
    pageNumberFormat === "dash"
      ? run("— ") + field("PAGE", "1") + run(" —")
      : pageNumberFormat === "chinese"
        ? run("第 ") + field("PAGE", "1") + run(" 页") + total
        : field("PAGE", "1") + total;
  const prefix = text ? run(text + "　") : "";
  return (
    XML_DECL +
    '<w:ftr xmlns:w="' + W_NS + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    "<w:p><w:pPr>" +
    '<w:pStyle w:val="Footer"/><w:jc w:val="' + jc + '"/>' +
    '<w:ind w:firstLineChars="0" w:firstLine="0"/>' +
    "</w:pPr>" + prefix + pageRun + "</w:p></w:ftr>"
  );
}

function emptyHeaderFooter(kind: "hdr" | "ftr"): string {
  return (
    XML_DECL +
    "<w:" + kind + ' xmlns:w="' + W_NS + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    "<w:p/></w:" + kind + ">"
  );
}

// ---------------------------------------------------------------- document assembly

function headerTextOf(doc: DocumentIR, theme: DocTemplate): string {
  const raw = doc.header ?? theme.headerFooter.headerText;
  const meta = doc.meta ?? {};
  return raw
    .replace(/\{title\}/g, doc.title)
    .replace(/\{docNo\}/g, meta.docNo ?? "")
    .replace(/\{date\}/g, meta.date ?? "")
    .replace(/\{organization\}/g, meta.organization ?? "")
    .trim();
}

function footerTextOf(doc: DocumentIR, theme: DocTemplate): string {
  const raw = doc.footer ?? theme.headerFooter.footerText;
  return raw.replace(/\{title\}/g, doc.title).trim();
}

interface Segment {
  blocks: IRBlock[];
  pageSetup: PageSetup | undefined;
  titlePage: boolean;
  startAtZero: boolean;
}

function buildSegments(doc: DocumentIR): Segment[] {
  const segments: Segment[] = [];
  doc.sections.forEach((section, sectionIndex) => {
    let current: Segment = {
      blocks: section.heading ? [{ type: "heading", level: 1, text: section.heading }, ...section.blocks] : [...section.blocks],
      pageSetup: section.page,
      titlePage: sectionIndex === 0,
      startAtZero: sectionIndex === 0,
    };
    for (const block of section.blocks) {
      if (block.type !== "sectionBreak") continue;
      const breakIndex = current.blocks.indexOf(block);
      if (breakIndex >= 0) current.blocks.splice(breakIndex, 1);
      segments.push(current);
      current = { blocks: [], pageSetup: block.page ?? current.pageSetup, titlePage: false, startAtZero: false };
    }
    segments.push(current);
  });
  return segments;
}

/** Renders blocks in order; a footnote mark is appended to the preceding paragraph. */
async function renderBlocksXml(
  state: RenderState,
  blocks: IRBlock[],
  resolveImage?: ImageResolver,
): Promise<string> {
  const parts: string[] = [];
  for (const block of blocks) {
    const xml = await blockXml(state, block, resolveImage);
    if (block.type === "footnote" || block.type === "endnote") {
      if (parts.length === 0) {
        parts.push("<w:p>" + xml + "</w:p>");
        continue;
      }
      const lastIndex = parts.length - 1;
      const previous = parts[lastIndex];
      const end = previous.lastIndexOf("</w:p>");
      if (end >= 0) parts[lastIndex] = previous.slice(0, end) + xml + previous.slice(end);
      else parts[lastIndex] = previous + "<w:p>" + xml + "</w:p>";
      continue;
    }
    parts.push(xml);
  }
  return parts.join("");
}

export async function renderDocument(options: RenderDocumentOptions): Promise<Buffer> {
  const { ir, template, templatePackage } = options;
  const state: RenderState = {
    theme: template,
    images: [],
    nextImageId: 1,
    drawingId: 0,
    bookmarkId: 0,
    figure: 0,
    table: 0,
    footnotes: [],
    endnotes: [],
    formula: 0,
    headingRefs: [],
    headingSeq: 0,
    ommlUsed: false,
    captionNumbering: ir.captionNumbering ?? "continuous",
    ...(ir.watermark ? { watermark: ir.watermark } : {}),
    // Page geometry drives cover bleed + image sizing.
    page: resolvePage(template.page, ir.page),
    ...(options.logo ? { logo: options.logo } : {}),
    heading: { h1: 0, h2: 0, h3: 0 },
    warning: [],
  };

  const coverEnabled = ir.cover ?? template.cover.enabled;
  const tocEnabled = ir.toc ?? template.toc.enabled;
  const segments = buildSegments(ir);
  const footnoteRestart = template.footnoteRestart ?? ir.footnoteRestart ?? "continuous";

  // Render all block XML first (image resolution is async).
  const rendered: string[] = [];
  if (coverEnabled) rendered.push(coverXml(state, ir));
  if (tocEnabled) rendered.push(tocXml(template, options.tocEntries));
  const sectionParts: string[] = [];
  for (const segment of segments) {
    sectionParts.push(await renderBlocksXml(state, segment.blocks, options.resolveImage));
  }

  if (templatePackage && templatePackage.byteLength > 0) {
    return renderIntoPackage(templatePackage, ir, state, rendered, sectionParts, options.tocEntries);
  }

  // Standard package.
  const docXml =
    XML_DECL +
    DOCUMENT_ROOT +
    "<w:body>" +
    rendered.join("") +
    sectionParts
      .map((body, index) => {
        const segment = segments[index];
        const page = resolvePage(template.page, segment.pageSetup ?? ir.page);
        const columns = segment.pageSetup?.columns ?? ir.page?.columns;
        return body + sectPrXml(state, page, {
          firstPageHeaderFooter: coverEnabled && segment.titlePage,
          startAtZero: coverEnabled && segment.startAtZero,
          ...(columns ? { columns } : {}),
          restartFootnotes: footnoteRestart === "section" && segments.length > 1,
        });
      })
      .join("") +
    "</w:body></w:document>";

  const zip = new JSZip();
  const hasEndnotes = state.endnotes.length > 0;
  zip.file("[Content_Types].xml", contentTypesXml(state.images, hasEndnotes));
  zip.file("_rels/.rels", packageRelsXml());
  zip.file("word/document.xml", docXml);
  zip.file("word/_rels/document.xml.rels", documentRelsXml(state.images, coverEnabled, hasEndnotes));
  zip.file("word/footnotes.xml", footnotesXml(state));
  if (hasEndnotes) zip.file("word/endnotes.xml", endnotesXml(state));
  zip.file("word/styles.xml", buildDocumentStylesXml(template));
  zip.file("word/numbering.xml", buildNumberingXml(template));
  zip.file("word/settings.xml", settingsXml());
  zip.file("word/theme/theme1.xml", themeXml(template));
  zip.file("docProps/core.xml", coreXml(ir));
  zip.file("docProps/app.xml", appPropsXml(ir));
  const header = headerTextOf(ir, template);
  const footer = footerTextOf(ir, template);
  zip.file("word/header1.xml", headerXml(state, header, [ir.meta?.organization, ir.meta?.docNo].filter((part): part is string => typeof part === "string" && part.trim() !== "").join(" · ")));
  zip.file("word/footer1.xml", footerXml(state, footer));
  zip.file("word/header2.xml", emptyHeaderFooter("hdr"));
  zip.file("word/footer2.xml", emptyHeaderFooter("ftr"));
  for (const image of state.images) zip.file("word/media/" + image.name, image.data);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// Known-valid Office theme skeleton (extracted from a Word-authored .docx) with
// our palette/fonts substituted. Hand-rolled minimal themes are rejected by Word.
const THEME_TEMPLATE = readFileSync(new URL("./theme-template.xml", import.meta.url), "utf8");

function themeXml(theme: DocTemplate): string {
  const accent = theme.typography.accentColor;
  const scheme =
    '<a:clrScheme name="MindBase">' +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="374151"/></a:dk2><a:lt2><a:srgbClr val="F2F3F5"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="' + accent + '"/></a:accent1>' +
    '<a:accent2><a:srgbClr val="2E5C8A"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="6B7280"/></a:accent3>' +
    '<a:accent4><a:srgbClr val="9CA3AF"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="1F4E79"/></a:accent5>' +
    '<a:accent6><a:srgbClr val="4B5563"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="1F4E79"/></a:hlink><a:folHlink><a:srgbClr val="6B7280"/></a:folHlink>' +
    "</a:clrScheme>";
  let xml = THEME_TEMPLATE;
  xml = xml.replace(/<a:clrScheme[\s\S]*?<\/a:clrScheme>/, scheme);
  xml = xml.replace(/(<a:majorFont>[\s\S]*?<a:ea typeface=")[^"]*(")/, "$1" + theme.typography.headingFontEastAsia + "$2");
  xml = xml.replace(/(<a:minorFont>[\s\S]*?<a:ea typeface=")[^"]*(")/, "$1" + theme.typography.bodyFontEastAsia + "$2");
  xml = xml.replace('name="Office Theme"', 'name="MindBase Office"');
  return xml;
}

function coreXml(ir: DocumentIR): string {
  const author = ir.meta?.author ?? ir.meta?.organization ?? "MindBase";
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    XML_DECL +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    "<dc:title>" + esc(ir.title) + "</dc:title>" +
    "<dc:creator>" + esc(author) + "</dc:creator>" +
    "<cp:lastModifiedBy>" + esc(author) + "</cp:lastModifiedBy>" +
    (ir.meta?.keywords && ir.meta.keywords.length > 0
      ? "<cp:keywords>" + esc(ir.meta.keywords.join("; ")) + "</cp:keywords>"
      : "") +
    (ir.subtitle ? "<dc:description>" + esc(ir.subtitle) + "</dc:description>" : "") +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + "</dcterms:created>" +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + "</dcterms:modified>" +
    "</cp:coreProperties>"
  );
}

function appPropsXml(ir: DocumentIR): string {
  return (
    XML_DECL +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"' +
    ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    "<Application>MindBase Office Renderer</Application>" +
    (ir.meta?.organization ? "<Company>" + esc(ir.meta.organization) + "</Company>" : "") +
    "<DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>" +
    "<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>" +
    "<HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion>" +
    "</Properties>"
  );
}

function contentTypesXml(images: ImageRel[], withEndnotes = false): string {
  const imageDefaults = new Set(images.map((image) => image.mime.includes("jpeg") ? "jpeg" : image.mime.includes("gif") ? "gif" : "png"));
  return (
    XML_DECL +
    '<Types xmlns="' + CT_NS + '">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    [...imageDefaults].map((ext) => '<Default Extension="' + ext + '" ContentType="image/' + (ext === "jpeg" ? "jpeg" : ext) + '"/>').join("") +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/word/footnotes.xml" ContentType="' + FOOTNOTES_CT + '"/>' +
    (withEndnotes ? '<Override PartName="/word/endnotes.xml" ContentType="' + ENDNOTES_CT + '"/>' : "") +
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
    '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
    '<Override PartName="/word/header2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
    '<Override PartName="/word/footer2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
    '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    "</Types>"
  );
}

function packageRelsXml(): string {
  return (
    XML_DECL +
    '<Relationships xmlns="' + RELS_NS + '">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    "</Relationships>"
  );
}

function documentRelsXml(images: ImageRel[], withFirstPage: boolean, withEndnotes = false): string {
  const rel = (id: string, type: string, target: string): string =>
    '<Relationship Id="' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + type + '" Target="' + target + '"/>';
  return (
    XML_DECL +
    '<Relationships xmlns="' + RELS_NS + '">' +
    rel("rId1", "styles", "styles.xml") +
    rel("rId2", "numbering", "numbering.xml") +
    rel("rId3", "header", "header1.xml") +
    rel("rId4", "footer", "footer1.xml") +
    rel("rId5", "header", "header2.xml") +
    rel("rId6", "footer", "footer2.xml") +
    rel("rId7", "settings", "settings.xml") +
    rel("rId8", "theme", "theme/theme1.xml") +
    rel("rId9", "footnotes", "footnotes.xml") +
    (withEndnotes ? rel("rIdEndnotes", "endnotes", "endnotes.xml") : "") +
    images.map((image) => rel(image.id, "image", "media/" + image.name)).join("") +
    "</Relationships>"
  );
}

function settingsXml(): string {
  return (
    XML_DECL +
    '<w:settings xmlns:w="' + W_NS + '">' +
    '<w:updateFields w:val="true"/>' +
    '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
    "</w:settings>"
  );
}

/** Adds xmlns:m to a <w:document> root that does not declare the math namespace. */
function ensureMathNamespace(root: string): string {
  if (/xmlns:m=/.test(root)) return root;
  return root.replace(/>$/, ' xmlns:m="' + MATH_NS + '">');
}

/** User-template mode: replace document.xml only, keep styles/headers/page setup. */
async function renderIntoPackage(
  templatePackage: Uint8Array,
  ir: DocumentIR,
  state: RenderState,
  rendered: string[],
  sectionParts: string[],
  tocEntries?: TocEntry[],
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(templatePackage);
  const templateDocument = await readZipText(zip, "word/document.xml");
  const stylesXml = await readZipText(zip, "word/styles.xml");
  const styleIds = resolveStyleIds(parseStyleIds(stylesXml));
  state.templateMode = { styleIds };
  // Re-render with template style ids (block XML was rendered before we knew them).
  state.images = [];
  state.figure = 0;
  state.table = 0;
  state.bookmarkId = 0;
  state.footnotes = [];
  state.endnotes = [];
  state.formula = 0;
  state.headingRefs = [];
  state.headingSeq = 0;
  state.ommlUsed = false;
  state.heading = { h1: 0, h2: 0, h3: 0 };
  if (state.watermark) {
    // The user template owns header/footer parts; a VML shape cannot be injected
    // without replacing them, so the watermark is skipped in template mode.
    log.info("[OFFICE-RENDER] watermark skipped in template-package mode");
  }
  const rerendered: string[] = [];
  if (ir.cover ?? state.theme.cover.enabled) rerendered.push(coverXml(state, ir));
  if (ir.toc ?? state.theme.toc.enabled) rerendered.push(tocXml(state.theme, tocEntries));
  const segmentBodies: string[] = [];
  for (const segment of buildSegments(ir)) {
    segmentBodies.push(await renderBlocksXml(state, segment.blocks));
  }
  // Template mode renders OMML too; a template root created by another tool may
  // not declare xmlns:m, so it is injected here (styles/parts stay untouched).
  const baseRoot = extractDocumentRoot(templateDocument);
  const root = state.ommlUsed ? ensureMathNamespace(baseRoot) : baseRoot;
  const sectPr = extractSectPr(templateDocument) ?? "";
  const bodyXml =
    XML_DECL + root + "<w:body>" + rerendered.join("") + segmentBodies.join("") + sectPr + "</w:body></w:document>";
  zip.file("word/document.xml", bodyXml);

  // Extra parts the template package does not own (images + notes) are merged
  // into its existing relationships instead of replacing them.
  const existingRels = await readZipText(zip, "word/_rels/document.xml.rels");
  const rels: string[] = [];
  if (state.footnotes.length > 0) {
    rels.push(
      '<Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>',
    );
  }
  if (state.endnotes.length > 0 && !(existingRels ?? "").includes("relationships/endnotes")) {
    rels.push(
      '<Relationship Id="rIdEndnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>',
    );
  }
  for (const image of state.images) {
    rels.push(
      '<Relationship Id="' + image.id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/' + image.name + '"/>',
    );
  }
  if (rels.length > 0) {
    const base = existingRels
      ? existingRels.replace("</Relationships>", "")
      : XML_DECL + '<Relationships xmlns="' + RELS_NS + '">';
    zip.file("word/_rels/document.xml.rels", base + rels.join("") + "</Relationships>");
    for (const image of state.images) zip.file("word/media/" + image.name, image.data);
  }
  if (state.footnotes.length > 0) {
    zip.file("word/footnotes.xml", footnotesXml(state));
    const contentTypes = await readZipText(zip, "[Content_Types].xml");
    if (contentTypes && !contentTypes.includes("/word/footnotes.xml")) {
      zip.file(
        "[Content_Types].xml",
        contentTypes.replace(
          "</Types>",
          '<Override PartName="/word/footnotes.xml" ContentType="' + FOOTNOTES_CT + '"/></Types>',
        ),
      );
    }
  }
  if (state.endnotes.length > 0) {
    zip.file("word/endnotes.xml", endnotesXml(state));
    const contentTypes = await readZipText(zip, "[Content_Types].xml");
    if (contentTypes && !contentTypes.includes("/word/endnotes.xml")) {
      zip.file(
        "[Content_Types].xml",
        contentTypes.replace(
          "</Types>",
          '<Override PartName="/word/endnotes.xml" ContentType="' + ENDNOTES_CT + '"/></Types>',
        ),
      );
    }
  }
  void rendered;
  void sectionParts;
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export { collectTocHeadings, flattenBlocks };

