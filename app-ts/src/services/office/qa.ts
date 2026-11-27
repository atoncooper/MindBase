import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createLogger } from "../../logger.js";
import type { CommandResult, CommandRunner } from "../office-render/process.js";
import { NodeCommandRunner } from "../office-render/process.js";
import { OfficeRenderError } from "../office-render/renderer.js";
import type { OfficeRenderPort } from "../office-render/renderer.js";
import type { VisionReviewPort } from "../office-render/vision.js";

const log = createLogger("OFFICE-QA");

/**
 * DOCX rendering QA: DOCX -> PDF (LibreOffice) -> poppler text/font/image
 * extraction -> deterministic layout checks -> optional vision review.
 *
 * Why a separate service (not part of the DOCX builder): the builder can only
 * prove the *structure* is right. Layout defects (text past the margin, blank
 * pages, broken heading hierarchy, inconsistent page sizes, missing header /
 * footer) only show up after a real layout engine paginates the document, so
 * this service audits the rendered PDF instead of guessing from the IR.
 *
 * Failure direction: the deployment either has the renderer + poppler or it does
 * not. When unavailable the audit returns available:false with a Chinese reason
 * and an empty score — it never fabricates checks it did not run. A DOCX that
 * fails to convert also reports available:false rather than a fake score.
 */

export interface AuditFinding {
  /** Stable machine code (text-overflow / blank-page / heading-order / vision ...). */
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  /** 1-based page the finding belongs to (omitted for document-wide findings). */
  page?: number;
}

export interface AuditCheck {
  /** Chinese check name shown in the report table. */
  name: string;
  ok: boolean;
  detail: string;
}

export interface RenderedAuditPage {
  page: number;
  png: Uint8Array;
}

export interface DocxAudit {
  /** False = the rendering audit could not run (no LibreOffice / conversion failed). */
  available: boolean;
  /** Chinese explanation why the audit is unavailable. */
  reason?: string;
  pageCount: number;
  pageSize: { widthPt: number; heightPt: number };
  findings: AuditFinding[];
  checks: AuditCheck[];
  /** 100 - (error 12 / warning 4 / info 1), floored at 0. */
  score: number;
  /** Present when opts.renderPages was true and rasterization succeeded. */
  renderedPages?: RenderedAuditPage[];
}

export interface OfficeQaBinaries {
  pdfinfo?: string;
  pdftotext?: string;
  pdftohtml?: string;
  pdfimages?: string;
  pdftoppm?: string;
}

export interface OfficeQaLimits {
  /** Hard cap for rendered/vision pages (default 16). */
  maxPages?: number;
  /** Max page images sent to the vision model (default 6). */
  maxVisionImages?: number;
  /** Per-command timeout for poppler calls (default 30000 ms). */
  commandTimeoutMs?: number;
  /** Timeout for DOCX -> PDF conversion (default 120000 ms). */
  convertTimeoutMs?: number;
  /** DPI used when rasterizing audit pages (default 110). */
  dpi?: number;
  /** Minimum safe margin in points (default 25.2 = 0.35in). */
  minMarginPt?: number;
  /** Page tolerance ratio used to split overflow warning/error (default 0.02). */
  toleranceRatio?: number;
  /** Characters below which a non-cover page counts as blank (default 10). */
  blankPageChars?: number;
}

export interface OfficeQaDeps {
  renderer: OfficeRenderPort;
  /** Injected for tests; defaults to a real spawn-based runner. */
  runner?: CommandRunner;
  /** Injected for tests / deployments without a vision model. */
  vision?: VisionReviewPort;
  limits?: OfficeQaLimits;
  /** Absolute paths override PATH lookup for the poppler binaries. */
  binaries?: OfficeQaBinaries;
}

export interface OfficeQaAuditOptions {
  /** Rasterize up to maxPages pages (PNG) and include them in the result. */
  renderPages?: boolean;
  /** Ask the vision model to review the rendered pages (requires renderPages). */
  vision?: boolean;
  /** Overrides limits.maxPages for this call. */
  maxPages?: number;
}

type ResolvedLimits = Required<OfficeQaLimits>;

const DEFAULT_LIMITS: ResolvedLimits = {
  maxPages: 16,
  maxVisionImages: 6,
  commandTimeoutMs: 30_000,
  convertTimeoutMs: 120_000,
  dpi: 110,
  minMarginPt: 25.2,
  toleranceRatio: 0.02,
  blankPageChars: 10,
};

const DEFAULT_BINARIES: Required<OfficeQaBinaries> = {
  pdfinfo: "pdfinfo",
  pdftotext: "pdftotext",
  pdftohtml: "pdftohtml",
  pdfimages: "pdfimages",
  pdftoppm: "pdftoppm",
};

const HEADER_FOOTER_BAND_PT = 36; // 0.5in: header/footer text legitimately lives in the margin
const PAGE_NUMBER_RE = /第?\s*\d+\s*页|—\s*\d+\s*—|Page\s*\d+/i;
const CJK_RE = /[\u4e00-\u9fff]/;
const CJK_FONT_RE =
  /(SimSun|SimHei|Song|Hei|Kai|Fang|YaHei|PingFang|Noto.*(CJK|SC|TC)|Source Han|MingLiU|STSong|STHeiti|DengXian|WenQuanYi|思源|宋|黑|楷|仿宋|微软雅黑|等线)/i;

// ───────────────────────── parsed data structures ─────────────────────────

export interface BboxWord {
  text: string;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface BboxPage {
  /** 1-based page number (document order). */
  page: number;
  widthPt: number;
  heightPt: number;
  words: BboxWord[];
}

export interface PdfInfoSummary {
  pageCount: number;
  pageSize: { widthPt: number; heightPt: number };
}

export interface PdfTextRun {
  text: string;
  fontSizePt: number;
  fontFamily: string;
}

export interface PdfToHtmlPage {
  page: number;
  textRuns: PdfTextRun[];
}

export interface PdfImageInfo {
  page: number;
  /** Embedded resolution in pixels. */
  width: number;
  height: number;
  /** Pixels per inch; 0 when the tool did not report it. */
  xPpi: number;
  yPpi: number;
}

/** Pure input of the deterministic checks (already parsed from poppler output). */
export interface DocxCheckInput {
  pageCount: number;
  pageSize: { widthPt: number; heightPt: number };
  pages: BboxPage[];
  fontPages: PdfToHtmlPage[];
  images: PdfImageInfo[];
  limits?: OfficeQaLimits;
}

export interface CheckOutcome {
  findings: AuditFinding[];
  check: AuditCheck;
}

// ─────────────────────────────── parsing ───────────────────────────────

function attr(attrs: string, name: string): string | undefined {
  const match = new RegExp(name + "\\s*=\\s*\"([^\"]*)\"").exec(attrs);
  return match ? match[1] : undefined;
}

function numberAttr(attrs: string, name: string): number {
  const raw = attr(attrs, name);
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function decodeXmlEntities(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (match, entity: string) => {
    switch (entity) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        if (entity.startsWith("#x") || entity.startsWith("#X")) {
          const code = Number.parseInt(entity.slice(2), 16);
          return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        const code = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
    }
  });
}

function cleanText(text: string): string {
  return decodeXmlEntities(text.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Parses "pdfinfo" output (page count + first-page size in pt). */
export function parsePdfInfo(stdout: string): PdfInfoSummary {
  const pages = /^\s*Pages:\s+(\d+)/m.exec(stdout);
  const size = /^\s*Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m.exec(stdout);
  return {
    pageCount: pages ? Number(pages[1]) : 0,
    pageSize: {
      widthPt: size ? Number(size[1]) : 0,
      heightPt: size ? Number(size[2]) : 0,
    },
  };
}

/** Parses "pdftotext -bbox-layout" XHTML into per-page word boxes. */
export function parseBboxLayout(xhtml: string): BboxPage[] {
  const pages: BboxPage[] = [];
  const pageRe = /<page\b([^>]*)>([\s\S]*?)<\/page>/g;
  let info: RegExpExecArray | null;
  while ((info = pageRe.exec(xhtml)) !== null) {
    const attrs = info[1];
    const body = info[2];
    const words: BboxWord[] = [];
    const wordRe = /<word\b([^>]*)>([\s\S]*?)<\/word>/g;
    let word: RegExpExecArray | null;
    while ((word = wordRe.exec(body)) !== null) {
      const text = cleanText(word[2]);
      if (text === "") continue;
      words.push({
        text,
        xMin: numberAttr(word[1], "xMin"),
        yMin: numberAttr(word[1], "yMin"),
        xMax: numberAttr(word[1], "xMax"),
        yMax: numberAttr(word[1], "yMax"),
      });
    }
    pages.push({
      page: pages.length + 1,
      widthPt: numberAttr(attrs, "width"),
      heightPt: numberAttr(attrs, "height"),
      words,
    });
  }
  return pages;
}

/** Parses "pdftohtml -xml" output into per-page text runs with font size/family. */
export function parsePdfToHtml(xml: string): PdfToHtmlPage[] {
  const pages: PdfToHtmlPage[] = [];
  const pageRe = /<page\b([^>]*)>([\s\S]*?)<\/page>/g;
  let info: RegExpExecArray | null;
  while ((info = pageRe.exec(xml)) !== null) {
    const attrs = info[1];
    const body = info[2];
    const pageNumber = numberAttr(attrs, "number") || pages.length + 1;
    const fonts = new Map<string, { size: number; family: string }>();
    const fontRe = /<fontspec\b([^>]*?)\/?>/g;
    let font: RegExpExecArray | null;
    while ((font = fontRe.exec(body)) !== null) {
      const id = attr(font[1], "id");
      if (id === undefined) continue;
      fonts.set(id, {
        size: numberAttr(font[1], "size"),
        family: attr(font[1], "family") ?? "",
      });
    }
    const textRuns: PdfTextRun[] = [];
    const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    let text: RegExpExecArray | null;
    while ((text = textRe.exec(body)) !== null) {
      const content = cleanText(text[2]);
      if (content === "") continue;
      const spec = fonts.get(attr(text[1], "font") ?? "");
      textRuns.push({
        text: content,
        fontSizePt: spec ? spec.size : 0,
        fontFamily: spec ? spec.family : "",
      });
    }
    pages.push({ page: pageNumber, textRuns });
  }
  return pages;
}

/** Parses "pdfimages -list" rows (only real image rows, not smask rows). */
export function parsePdfImagesList(stdout: string): PdfImageInfo[] {
  const images: PdfImageInfo[] = [];
  const rowRe =
    /^\s*(\d+)\s+(\d+)\s+(image|smask)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+([\d.+-]+)\s+([\d.+-]+)/;
  for (const line of stdout.split(/\r?\n/)) {
    const match = rowRe.exec(line);
    if (!match || match[3] !== "image") continue;
    images.push({
      page: Number(match[1]),
      width: Number(match[4]),
      height: Number(match[5]),
      xPpi: Number(match[13]),
      yPpi: Number(match[14]),
    });
  }
  return images;
}

// ─────────────────────────── shared helpers ───────────────────────────

function resolveLimits(limits?: OfficeQaLimits): ResolvedLimits {
  return { ...DEFAULT_LIMITS, ...(limits ?? {}) };
}

export interface PageLine {
  text: string;
  yMin: number;
  yMax: number;
}

/** Groups a page's word boxes into visual lines (used by header/footer checks). */
export function pageLines(page: BboxPage): PageLine[] {
  const words = [...page.words].sort((a, b) => a.yMin - b.yMin || a.xMin - b.xMin);
  const lines: PageLine[] = [];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.yMin - word.yMin) <= 2.5) {
      last.text += " " + word.text;
      last.yMax = Math.max(last.yMax, word.yMax);
      continue;
    }
    lines.push({ text: word.text, yMin: word.yMin, yMax: word.yMax });
  }
  return lines;
}

function pageText(page: BboxPage): string {
  return page.words.map((word) => word.text).join(" ");
}

function isCoverOrTocPage(page: BboxPage): boolean {
  return page.page === 1 || /目\s*录|contents/i.test(pageText(page));
}

function headingLevel(text: string): number | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (/^第[一二三四五六七八九十百零〇\d]+[章节篇]/.test(normalized)) return 1;
  const numbered = /^(\d{1,3}(?:\.\d{1,3}){0,2})\s*[、.．]?\s+\S/.exec(normalized);
  if (numbered) {
    const parts = numbered[1].split(".");
    if (parts.length === 1 && parts[0].length === 4) return undefined; // 4-digit year, not a heading number
    return Math.min(3, parts.length);
  }
  if (/^[一二三四五六七八九十]+[、.．]\s*\S/.test(normalized)) return 2;
  return undefined;
}

function dominantFontSize(runs: PdfTextRun[]): number {
  const histogram = new Map<string, { size: number; count: number }>();
  for (const run of runs) {
    if (!(run.fontSizePt > 0)) continue;
    const key = (Math.round(run.fontSizePt * 10) / 10).toFixed(1);
    const entry = histogram.get(key);
    if (entry) entry.count += 1;
    else histogram.set(key, { size: run.fontSizePt, count: 1 });
  }
  let best: { size: number; count: number } | undefined;
  for (const entry of histogram.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best ? best.size : 0;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function okCheck(name: string, detail: string): AuditCheck {
  return { name, ok: true, detail };
}

// ─────────────────────────── deterministic checks ───────────────────────────

/**
 * 1) Text overflow: body words outside the safe area (margin min 0.35in, with a
 * page-dimension tolerance). Header/footer bands are excluded because running
 * text legitimately sits in the margin. Past the tolerance = error, inside it =
 * warning.
 */
export function checkTextOverflow(
  pages: BboxPage[],
  pageSize: { widthPt: number; heightPt: number },
  limits?: OfficeQaLimits,
): CheckOutcome {
  const resolved = resolveLimits(limits);
  const findings: AuditFinding[] = [];
  for (const page of pages) {
    const width = page.widthPt > 0 ? page.widthPt : pageSize.widthPt;
    const height = page.heightPt > 0 ? page.heightPt : pageSize.heightPt;
    if (width <= 0 || height <= 0) continue;
    const tolerance = Math.max(width * resolved.toleranceRatio, height * resolved.toleranceRatio);
    let worstGap = 0;
    let count = 0;
    for (const word of page.words) {
      if (word.yMax <= HEADER_FOOTER_BAND_PT || word.yMin >= height - HEADER_FOOTER_BAND_PT) continue;
      const gap = Math.max(
        resolved.minMarginPt - word.xMin,
        word.xMax - (width - resolved.minMarginPt),
        resolved.minMarginPt - word.yMin,
        word.yMax - (height - resolved.minMarginPt),
      );
      if (gap > 0.5) {
        count += 1;
        worstGap = Math.max(worstGap, gap);
      }
    }
    if (count > 0) {
      findings.push({
        code: "text-overflow",
        severity: worstGap > tolerance ? "error" : "warning",
        page: page.page,
        message:
          "第 " +
          page.page +
          " 页有 " +
          count +
          " 处文本超出安全边距（最多超出 " +
          round1(worstGap) +
          " pt，安全边距 " +
          round1(resolved.minMarginPt) +
          " pt）",
      });
    }
  }
  return {
    findings,
    check: findings.length === 0 ? okCheck("文本越界", "全部正文文本均在安全边距内") : { name: "文本越界", ok: false, detail: "发现 " + findings.length + " 页文本越界" },
  };
}

/** 2) Blank pages: < blankPageChars characters on a non-cover/non-TOC page. */
export function checkBlankPages(pages: BboxPage[], limits?: OfficeQaLimits): CheckOutcome {
  const resolved = resolveLimits(limits);
  const findings: AuditFinding[] = [];
  for (const page of pages) {
    if (isCoverOrTocPage(page)) continue;
    const characters = page.words.map((word) => word.text).join("").replace(/\s/g, "").length;
    if (characters < resolved.blankPageChars) {
      findings.push({
        code: "blank-page",
        severity: "warning",
        page: page.page,
        message: "第 " + page.page + " 页内容过少（" + characters + " 个字符），可能是空白页",
      });
    }
  }
  return {
    findings,
    check:
      findings.length === 0
        ? okCheck("空白页", "未发现异常空白页")
        : { name: "空白页", ok: false, detail: "发现 " + findings.length + " 个疑似空白页" },
  };
}

/** 3) Header/footer stability on pages 2..6 (same text or a page-number pattern). */
export function checkHeaderFooter(
  pages: BboxPage[],
  pageSize: { widthPt: number; heightPt: number },
): CheckOutcome {
  const findings: AuditFinding[] = [];
  const target = pages.filter((page) => page.page >= 2).slice(0, 6);
  if (target.length < 2) return { findings, check: okCheck("页眉页脚", "页数不足 2 页，跳过页眉页脚检查") };

  const headers: Array<{ page: number; text: string }> = [];
  const footers: Array<{ page: number; text: string }> = [];
  const missingHeaderPages: number[] = [];
  const missingFooterPages: number[] = [];
  for (const page of target) {
    const height = page.heightPt > 0 ? page.heightPt : pageSize.heightPt;
    const lines = pageLines(page);
    const header = lines.find((line) => line.yMax <= HEADER_FOOTER_BAND_PT);
    const footer = [...lines].reverse().find((line) => line.yMin >= height - HEADER_FOOTER_BAND_PT);
    if (header) headers.push({ page: page.page, text: header.text.trim() });
    else missingHeaderPages.push(page.page);
    if (footer) footers.push({ page: page.page, text: footer.text.trim() });
    else missingFooterPages.push(page.page);
  }

  if (missingHeaderPages.length > 0) {
    findings.push({
      code: "header-footer",
      severity: "warning",
      page: missingHeaderPages[0],
      message: "第 " + missingHeaderPages[0] + " 页起顶部 0.5in 内未检测到页眉文本（共 " + missingHeaderPages.length + " 页缺失）",
    });
  }
  if (missingFooterPages.length > 0) {
    findings.push({
      code: "header-footer",
      severity: "warning",
      page: missingFooterPages[0],
      message: "第 " + missingFooterPages[0] + " 页起底部 0.5in 内未检测到页脚/页码（共 " + missingFooterPages.length + " 页缺失）",
    });
  }

  const unstable = (items: Array<{ page: number; text: string }>): { page: number; texts: string[] } | undefined => {
    if (items.length < 2) return undefined;
    const texts = items.map((item) => item.text);
    const same = texts.every((text) => text === texts[0]);
    const paged = texts.every((text) => PAGE_NUMBER_RE.test(text));
    if (same || paged) return undefined;
    return { page: items[0].page, texts };
  };
  const headerIssue = unstable(headers);
  if (headerIssue) {
    findings.push({
      code: "header-footer",
      severity: "warning",
      page: headerIssue.page,
      message: "页眉在第 2–6 页内不稳定（" + headerIssue.texts.slice(0, 3).join(" / ") + " 等）",
    });
  }
  const footerIssue = unstable(footers);
  if (footerIssue) {
    findings.push({
      code: "header-footer",
      severity: "warning",
      page: footerIssue.page,
      message: "页脚在第 2–6 页内不稳定（" + footerIssue.texts.slice(0, 3).join(" / ") + " 等）",
    });
  }

  return {
    findings,
    check:
      findings.length === 0
        ? okCheck("页眉页脚", "页眉页脚在第 2–6 页内一致（含页码模式）")
        : { name: "页眉页脚", ok: false, detail: "页眉/页脚存在缺失或不一致" },
  };
}

/** 4) Heading hierarchy from pdftohtml font sizes + heading numbering. */
export function checkHeadingHierarchy(fontPages: PdfToHtmlPage[]): CheckOutcome {
  const findings: AuditFinding[] = [];
  const runs = fontPages.flatMap((page) => page.textRuns).filter((run) => run.text.trim() !== "" && run.fontSizePt > 0);
  if (runs.length === 0) return { findings, check: okCheck("标题层级", "未获取到字号信息（pdftohtml 不可用），跳过标题层级检查") };

  const bodySize = dominantFontSize(runs);
  const headings = runs
    .map((run) => ({ ...run, level: headingLevel(run.text) }))
    .filter((run): run is PdfTextRun & { level: number } => run.level !== undefined && run.fontSizePt > bodySize + 0.5);
  if (headings.length === 0) return { findings, check: okCheck("标题层级", "未检测到带编号的多级标题，跳过层级检查") };

  const sizesByLevel = new Map<number, number[]>();
  for (const heading of headings) {
    const sizes = sizesByLevel.get(heading.level) ?? [];
    sizes.push(heading.fontSizePt);
    sizesByLevel.set(heading.level, sizes);
  }
  const levels = [...sizesByLevel.keys()].sort((a, b) => a - b);
  for (const level of levels) {
    const sizes = sizesByLevel.get(level) as number[];
    const spread = Math.max(...sizes) - Math.min(...sizes);
    if (spread > 0.5) {
      findings.push({
        code: "heading-size",
        severity: "warning",
        message:
          "H" +
          level +
          " 标题字号不一致（" +
          round1(Math.min(...sizes)) +
          "–" +
          round1(Math.max(...sizes)) +
          " pt，允许 0.5 pt 误差）",
      });
    }
  }
  for (let level = 1; level <= 2; level += 1) {
    if (!sizesByLevel.has(level) || !sizesByLevel.has(level + 1)) continue;
    const upper = average(sizesByLevel.get(level) as number[]);
    const lower = average(sizesByLevel.get(level + 1) as number[]);
    if (upper <= lower + 0.5) {
      findings.push({
        code: "heading-order",
        severity: "error",
        message:
          "标题字号倒挂：H" +
          level +
          "（" +
          round1(upper) +
          " pt）没有大于 H" +
          (level + 1) +
          "（" +
          round1(lower) +
          " pt）",
      });
    }
  }

  const summary = levels.map((level) => "H" + level + " " + round1(average(sizesByLevel.get(level) as number[])) + " pt").join(" / ");
  return {
    findings,
    check:
      findings.length === 0
        ? okCheck("标题层级", "标题层级正常（" + summary + "）")
        : { name: "标题层级", ok: false, detail: "标题字号层级异常（" + summary + "）" },
  };
}

/** 5) Font consistency: <= 4 families and a CJK family present for Chinese text. */
export function checkFonts(fontPages: PdfToHtmlPage[], bodyText: string): CheckOutcome {
  const findings: AuditFinding[] = [];
  const runs = fontPages.flatMap((page) => page.textRuns).filter((run) => run.fontSizePt > 0);
  if (runs.length === 0) return { findings, check: okCheck("字体一致性", "未获取到字体信息（pdftohtml 不可用），跳过字体检查") };

  const families = new Set<string>();
  for (const run of runs) {
    const family = run.fontFamily.replace(/^[A-Z]{6}\+/, "").trim();
    if (family !== "") families.add(family);
  }
  if (families.size > 4) {
    findings.push({
      code: "font-mixed",
      severity: "warning",
      message: "字体族过多（" + families.size + " 种：" + [...families].slice(0, 6).join("、") + "），版式可能不统一",
    });
  }
  const hasCjkText = CJK_RE.test(bodyText);
  const hasCjkFont = [...families].some((family) => CJK_FONT_RE.test(family));
  if (hasCjkText && !hasCjkFont) {
    findings.push({
      code: "font-cjk-missing",
      severity: "warning",
      message: "正文含中文但未检测到中文字体（字体可能未嵌入或发生回退），请确认 PDF 中文显示正常",
    });
  }

  const detail = okCheck("字体一致性", "共 " + families.size + " 种字体族（" + [...families].slice(0, 4).join("、") + "）");
  return { findings, check: findings.length === 0 ? detail : { name: "字体一致性", ok: false, detail: "字体族过多或缺少中文字体" } };
}

/** 6) Table of contents in the first 3 pages (dot leaders / page numbers). */
export function checkTableOfContents(pages: BboxPage[]): CheckOutcome {
  const findings: AuditFinding[] = [];
  if (pages.length < 3) return { findings, check: okCheck("目录", "页数不足 3 页，跳过目录检查") };
  const firstPages = pages.filter((page) => page.page <= 3);
  const text = firstPages.map(pageText).join("\n");
  const hasTocTitle = /目\s*录|contents/i.test(text);
  const hasLeader = /[.·…]{3,}/.test(text) || /(?:^|\s)\d{1,4}\s*$/m.test(text);
  if (!hasTocTitle) {
    findings.push({
      code: "toc-missing",
      severity: "info",
      message: "前 3 页未检测到目录（无「目录」标题）；长文档建议生成目录便于导航",
    });
  } else if (!hasLeader) {
    findings.push({
      code: "toc-incomplete",
      severity: "info",
      message: "检测到「目录」但未发现点线/页码引导符，目录条目可能不完整",
    });
  }
  return {
    findings,
    check:
      findings.length === 0
        ? okCheck("目录", "文首检测到含点线/页码的目录")
        : { name: "目录", ok: false, detail: "目录缺失或不完整（info）" },
  };
}

/** 7) Image sanity: aspect ratio and embedded width vs page width. */
export function checkImages(
  images: PdfImageInfo[],
  pages: BboxPage[],
  bodyText: string,
  pageSize: { widthPt: number; heightPt: number },
): CheckOutcome {
  const findings: AuditFinding[] = [];
  const pageWidth = pages[0] && pages[0].widthPt > 0 ? pages[0].widthPt : pageSize.widthPt;
  if (images.length === 0) {
    if (/(?:图|Figure|Fig\.?)\s*\d+|如下图|下图|如图/.test(bodyText)) {
      findings.push({
        code: "image-missing",
        severity: "info",
        message: "正文提到图片，但 PDF 中未检测到任何图片，可能图片未成功嵌入",
      });
    }
    return {
      findings,
      check:
        findings.length === 0
          ? okCheck("图片", "未检测到图片，正文也未引用图片")
          : { name: "图片", ok: false, detail: "正文引用了图片但未检测到图片对象（info）" },
    };
  }
  for (const image of images) {
    if (!(image.width > 0) || !(image.height > 0)) continue;
    const ratio = image.width / image.height;
    if (ratio < 0.2 || ratio > 5) {
      findings.push({
        code: "image-ratio",
        severity: "warning",
        page: image.page,
        message: "第 " + image.page + " 页图片宽高比异常（" + round1(ratio) + "，合理范围 0.2–5）",
      });
    }
    if (pageWidth > 0) {
      const ppi = image.xPpi > 0 ? image.xPpi : 96;
      const widthPt = (image.width * 72) / ppi;
      if (widthPt > pageWidth + 1) {
        findings.push({
          code: "image-too-wide",
          severity: "warning",
          page: image.page,
          message: "第 " + image.page + " 页图片嵌入宽度约 " + Math.round(widthPt) + " pt，超过页面宽度 " + Math.round(pageWidth) + " pt",
        });
      }
    }
  }
  return {
    findings,
    check:
      findings.length === 0
        ? okCheck("图片", "共 " + images.length + " 张图片，尺寸与宽高比正常")
        : { name: "图片", ok: false, detail: "图片尺寸/宽高比异常" },
  };
}

/** 8) Page size consistency: every page within 2pt of the first page's size. */
export function checkPageSizes(pages: BboxPage[], pageSize: { widthPt: number; heightPt: number }): CheckOutcome {
  const findings: AuditFinding[] = [];
  const sized = pages.filter((page) => page.widthPt > 0 && page.heightPt > 0);
  if (sized.length === 0) return { findings, check: okCheck("页面尺寸", "未获取到逐页尺寸信息，跳过尺寸一致性检查") };
  const baseline = sized[0];
  for (const page of sized.slice(1)) {
    if (Math.abs(page.widthPt - baseline.widthPt) > 2 || Math.abs(page.heightPt - baseline.heightPt) > 2) {
      findings.push({
        code: "page-size",
        severity: "warning",
        page: page.page,
        message:
          "第 " +
          page.page +
          " 页尺寸 " +
          Math.round(page.widthPt) +
          "×" +
          Math.round(page.heightPt) +
          " pt 与首页 " +
          Math.round(baseline.widthPt) +
          "×" +
          Math.round(baseline.heightPt) +
          " pt 不一致（横向混排需在文档中说明）",
      });
    }
  }
  return {
    findings,
    check:
      findings.length === 0
        ? okCheck("页面尺寸", "全部页面尺寸一致（" + Math.round(pageSize.widthPt || baseline.widthPt) + "×" + Math.round(pageSize.heightPt || baseline.heightPt) + " pt）")
        : { name: "页面尺寸", ok: false, detail: "存在页面尺寸不一致" },
  };
}

/**
 * Runs every deterministic check on parsed poppler data. Pure and side-effect
 * free so tests can feed fixed poppler output without any binary installed.
 */
export function evaluateDocument(input: DocxCheckInput): { findings: AuditFinding[]; checks: AuditCheck[] } {
  const limits = input.limits;
  const bodyText =
    input.pages.map(pageText).join(" ") +
    " " +
    input.fontPages.flatMap((page) => page.textRuns.map((run) => run.text)).join(" ");
  const outcomes: CheckOutcome[] = [
    checkTextOverflow(input.pages, input.pageSize, limits),
    checkBlankPages(input.pages, limits),
    checkHeaderFooter(input.pages, input.pageSize),
    checkHeadingHierarchy(input.fontPages),
    checkFonts(input.fontPages, bodyText),
    checkTableOfContents(input.pages),
    checkImages(input.images, input.pages, bodyText, input.pageSize),
    checkPageSizes(input.pages, input.pageSize),
  ];
  return {
    findings: outcomes.flatMap((outcome) => outcome.findings),
    checks: outcomes.map((outcome) => outcome.check),
  };
}

/** 100 - (error 12 / warning 4 / info 1), never below 0. */
export function scoreFindings(findings: AuditFinding[]): number {
  let score = 100;
  for (const finding of findings) {
    score -= finding.severity === "error" ? 12 : finding.severity === "warning" ? 4 : 1;
  }
  return Math.max(0, score);
}

// ───────────────────────────── report rendering ─────────────────────────────

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function severityLabel(severity: AuditFinding["severity"]): string {
  return severity === "error" ? "错误" : severity === "warning" ? "警告" : "提示";
}

/** Chinese markdown report (available state, score, checks, findings). */
export function renderAuditMarkdown(audit: DocxAudit): string {
  const lines: string[] = ["# 文档质检报告", ""];
  if (!audit.available) {
    lines.push("**结论：不可用** — " + (audit.reason ?? "版面渲染/质检环境不可用"));
    lines.push("");
    lines.push("> 本报告未执行任何版式检查，也没有评分；请先安装 LibreOffice + poppler（或以 WITH_OFFICE_RENDERER=1 构建镜像）后重试。");
    if (audit.checks.length > 0) {
      lines.push("");
      lines.push("## 检查项");
      lines.push("");
      lines.push("| 检查项 | 结果 | 说明 |");
      lines.push("| --- | --- | --- |");
      for (const check of audit.checks) {
        lines.push("| " + escapeCell(check.name) + " | " + (check.ok ? "通过" : "未执行/失败") + " | " + escapeCell(check.detail) + " |");
      }
    }
    return lines.join("\n") + "\n";
  }

  const verdict = audit.score >= 90 ? "良好" : audit.score >= 75 ? "需关注" : "需修复";
  lines.push("- 结论：" + verdict + "（" + audit.score + "/100）");
  lines.push("- 页数：" + audit.pageCount + " 页");
  lines.push(
    "- 页面尺寸：" +
      round1(audit.pageSize.widthPt) +
      " × " +
      round1(audit.pageSize.heightPt) +
      " pt（" +
      pageSizeLabel(audit.pageSize) +
      "）",
  );
  lines.push("- 问题统计：" + countFindings(audit.findings));
  if (audit.renderedPages && audit.renderedPages.length > 0) {
    lines.push("- 已渲染页面图：" + audit.renderedPages.length + " 页");
  }
  lines.push("");
  lines.push("## 检查项");
  lines.push("");
  lines.push("| 检查项 | 结果 | 说明 |");
  lines.push("| --- | --- | --- |");
  for (const check of audit.checks) {
    lines.push("| " + escapeCell(check.name) + " | " + (check.ok ? "通过" : "问题") + " | " + escapeCell(check.detail) + " |");
  }
  lines.push("");
  lines.push("## 问题清单");
  lines.push("");
  if (audit.findings.length === 0) {
    lines.push("未发现问题。");
  } else {
    lines.push("| 级别 | 代码 | 页码 | 说明 |");
    lines.push("| --- | --- | --- | --- |");
    for (const finding of audit.findings) {
      lines.push(
        "| " +
          severityLabel(finding.severity) +
          " | " +
          escapeCell(finding.code) +
          " | " +
          (finding.page === undefined ? "-" : String(finding.page)) +
          " | " +
          escapeCell(finding.message) +
          " |",
      );
    }
  }
  return lines.join("\n") + "\n";
}

function pageSizeLabel(size: { widthPt: number; heightPt: number }): string {
  const width = size.widthPt;
  const height = size.heightPt;
  if (Math.abs(width - 595.276) < 2 && Math.abs(height - 841.89) < 2) return "A4 纵向";
  if (Math.abs(width - 841.89) < 2 && Math.abs(height - 595.276) < 2) return "A4 横向";
  if (Math.abs(width - 612) < 2 && Math.abs(height - 792) < 2) return "Letter 纵向";
  if (Math.abs(width - 1190.55) < 2 && Math.abs(height - 841.89) < 2) return "A3 横向";
  return width > height ? "横向" : "纵向";
}

function countFindings(findings: AuditFinding[]): string {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  const infos = findings.filter((finding) => finding.severity === "info").length;
  return "错误 " + errors + " / 警告 " + warnings + " / 提示 " + infos;
}

// ───────────────────────────── service ─────────────────────────────

const VISION_INSTRUCTIONS =
  "你是 Word 文档版式审查员。下面是一个 Word 文档经 LibreOffice 渲染后的逐页图片，" +
  "请重点检查：1) 文字溢出页面或被截断；2) 表格跨页断裂/内容截断；3) 标题孤行（标题在页尾、正文在下一页）；" +
  "4) 大面积异常留白。请用中文逐页列出具体问题；如果未发现明显问题，请回答「未发现明显版式问题」。";

function commandError(result: CommandResult): string {
  if (result.timedOut) return "命令超时";
  const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 300);
  return detail === "" ? "exit code " + String(result.code) : detail;
}

function unavailableAudit(reason: string, checks?: AuditCheck[]): DocxAudit {
  return {
    available: false,
    reason,
    pageCount: 0,
    pageSize: { widthPt: 0, heightPt: 0 },
    findings: [],
    checks: checks ?? [{ name: "渲染可用", ok: false, detail: reason }],
    score: 0,
  };
}

/**
 * Rendering QA service. Deps are ports so the entire pipeline is offline-testable:
 * the renderer fake returns PDF bytes, the command runner fake returns fixed
 * poppler output, the vision fake returns a fixed review text.
 */
export class OfficeQaService {
  private readonly renderer: OfficeRenderPort;
  private readonly runner: CommandRunner;
  private readonly vision?: VisionReviewPort;
  private readonly limits: ResolvedLimits;
  private readonly binaries: Required<OfficeQaBinaries>;

  constructor(deps: OfficeQaDeps) {
    this.renderer = deps.renderer;
    this.runner = deps.runner ?? new NodeCommandRunner();
    this.vision = deps.vision;
    this.limits = resolveLimits(deps.limits);
    this.binaries = { ...DEFAULT_BINARIES, ...(deps.binaries ?? {}) };
  }

  /** True when this deployment can run the rendering audit at all. */
  get available(): boolean {
    return this.renderer.available && typeof this.renderer.convertToPdf === "function";
  }

  /** Chinese reason why the audit is unavailable (empty when available). */
  get unavailableReason(): string {
    if (!this.renderer.available) {
      return this.renderer.unavailableReason ?? "版面渲染不可用（未安装 LibreOffice / 渲染已关闭），无法进行 DOCX 版面质检";
    }
    if (typeof this.renderer.convertToPdf !== "function") {
      return "当前渲染器不支持 DOCX→PDF 转换，无法进行 DOCX 版面质检";
    }
    return "";
  }

  async audit(input: { fileName: string; bytes: Uint8Array }, opts: OfficeQaAuditOptions = {}): Promise<DocxAudit> {
    if (!this.available) return unavailableAudit(this.unavailableReason);
    if (input.bytes.byteLength === 0) return unavailableAudit("文件为空，无法质检");

    let pdfBytes: Uint8Array;
    let declaredPageCount: number | undefined;
    try {
      const conversion = await this.renderer.convertToPdf!(input, { timeoutMs: this.limits.convertTimeoutMs });
      pdfBytes = conversion.data;
      declaredPageCount = conversion.pageCount;
    } catch (err) {
      const message = err instanceof OfficeRenderError ? err.message : err instanceof Error ? err.message : String(err);
      return unavailableAudit("DOCX 转 PDF 失败：" + message, [{ name: "DOCX 转 PDF", ok: false, detail: message }]);
    }
    if (!pdfBytes || pdfBytes.byteLength === 0) {
      return unavailableAudit("DOCX 转 PDF 返回空文件", [{ name: "DOCX 转 PDF", ok: false, detail: "生成的 PDF 为空" }]);
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "office-qa-"));
    try {
      const pdfPath = path.join(dir, "source.pdf");
      await fs.writeFile(pdfPath, Buffer.from(pdfBytes));

      const infoResult = await this.run(this.binaries.pdfinfo, [pdfPath], dir);
      if (infoResult.timedOut || infoResult.code !== 0) {
        return unavailableAudit("pdfinfo 调用失败（poppler 不可用？）：" + commandError(infoResult));
      }
      const bboxResult = await this.run(this.binaries.pdftotext, ["-bbox-layout", pdfPath, "-"], dir);
      if (bboxResult.timedOut || bboxResult.code !== 0) {
        return unavailableAudit("pdftotext 调用失败（poppler 不可用？）：" + commandError(bboxResult));
      }

      const info = parsePdfInfo(infoResult.stdout);
      const pages = parseBboxLayout(bboxResult.stdout);
      const pageCount = info.pageCount > 0 ? info.pageCount : pages.length;
      if (pages.length === 0 || pageCount === 0) {
        return unavailableAudit("PDF 解析失败：未解析到任何页面（pdftotext -bbox-layout 输出为空）");
      }
      const pageSize =
        info.pageSize.widthPt > 0 && info.pageSize.heightPt > 0
          ? info.pageSize
          : { widthPt: pages[0].widthPt, heightPt: pages[0].heightPt };

      const findings: AuditFinding[] = [];
      const fontResult = await this.run(this.binaries.pdftohtml, ["-xml", "-hidden", "-stdout", pdfPath], dir);
      let fontPages: PdfToHtmlPage[] = [];
      if (fontResult.timedOut || fontResult.code !== 0) {
        findings.push({
          code: "pdftohtml-failed",
          severity: "info",
          message: "pdftohtml 调用失败，已跳过字体/标题层级检查：" + commandError(fontResult),
        });
      } else {
        fontPages = parsePdfToHtml(fontResult.stdout);
      }

      const imagesResult = await this.run(this.binaries.pdfimages, ["-list", pdfPath], dir);
      let images: PdfImageInfo[] = [];
      if (imagesResult.timedOut || imagesResult.code !== 0) {
        findings.push({
          code: "pdfimages-failed",
          severity: "info",
          message: "pdfimages 调用失败，已跳过图片尺寸检查：" + commandError(imagesResult),
        });
      } else {
        images = parsePdfImagesList(imagesResult.stdout);
      }

      const evaluated = evaluateDocument({ pageCount, pageSize, pages, fontPages, images, limits: this.limits });
      findings.push(...evaluated.findings);
      const checks: AuditCheck[] = [
        {
          name: "DOCX 转 PDF",
          ok: true,
          detail: "已转换（" + pageCount + " 页" + (declaredPageCount && declaredPageCount !== pageCount ? "，PDF 页树声明 " + declaredPageCount + " 页" : "") + "）",
        },
        ...evaluated.checks,
      ];

      let renderedPages: RenderedAuditPage[] | undefined;
      if (opts.renderPages === true) {
        const rendered = await this.renderPages(pdfPath, dir, opts.maxPages, findings);
        if (rendered) renderedPages = rendered;
      }

      if (opts.vision === true) {
        await this.applyVision(renderedPages, findings, checks);
      }

      const score = scoreFindings(findings);
      log.info(
        "[OFFICE-QA] audited file=%s pages=%d findings=%d score=%d",
        input.fileName,
        pageCount,
        findings.length,
        score,
      );
      return {
        available: true,
        pageCount,
        pageSize,
        findings,
        checks,
        score,
        ...(renderedPages ? { renderedPages } : {}),
      };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async run(command: string, args: string[], cwd: string): Promise<CommandResult> {
    return this.runner.run({
      command,
      args,
      cwd,
      env: { HOME: cwd, TMPDIR: cwd },
      timeoutMs: this.limits.commandTimeoutMs,
    });
  }

  private async renderPages(
    pdfPath: string,
    dir: string,
    maxPagesOption: number | undefined,
    findings: AuditFinding[],
  ): Promise<RenderedAuditPage[] | undefined> {
    const maxPages = Math.max(1, Math.min(64, maxPagesOption ?? this.limits.maxPages));
    const prefix = path.join(dir, "page");
    const result = await this.run(
      this.binaries.pdftoppm,
      ["-r", String(this.limits.dpi), "-png", "-f", "1", "-l", String(maxPages), pdfPath, prefix],
      dir,
    );
    if (result.timedOut || result.code !== 0) {
      findings.push({
        code: "render-pages",
        severity: "info",
        message: "页面图渲染失败（pdftoppm）：" + commandError(result),
      });
      return undefined;
    }
    const produced = (await fs.readdir(dir))
      .map((name) => /^page-(\d+)\.png$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ page: Number(match[1]), file: path.join(dir, match[0]) }))
      .sort((a, b) => a.page - b.page)
      .slice(0, maxPages);
    if (produced.length === 0) {
      findings.push({ code: "render-pages", severity: "info", message: "页面图渲染失败：未生成任何 PNG" });
      return undefined;
    }
    const pages: RenderedAuditPage[] = [];
    for (const item of produced) {
      pages.push({ page: item.page, png: new Uint8Array(await fs.readFile(item.file)) });
    }
    return pages;
  }

  private async applyVision(
    renderedPages: RenderedAuditPage[] | undefined,
    findings: AuditFinding[],
    checks: AuditCheck[],
  ): Promise<void> {
    const vision = this.vision;
    if (!vision || !vision.enabled) {
      findings.push({
        code: "vision",
        severity: "info",
        message: "视觉复核未启用（未配置视觉模型），已跳过；自动版式检查结果不受影响",
      });
      checks.push({ name: "视觉复核", ok: true, detail: "未启用视觉模型，跳过（不算失败）" });
      return;
    }
    const images = (renderedPages ?? []).slice(0, this.limits.maxVisionImages);
    if (images.length === 0) {
      findings.push({ code: "vision", severity: "info", message: "没有可用的页面图，已跳过视觉复核" });
      checks.push({ name: "视觉复核", ok: true, detail: "无页面图，跳过（不算失败）" });
      return;
    }
    try {
      const review = await vision.review({
        instructions: VISION_INSTRUCTIONS,
        images: images.map((page) => ({ page: page.page, data: page.png })),
      });
      const text = review.trim().slice(0, 1500);
      findings.push({ code: "vision", severity: "warning", message: "视觉复核：" + text });
      checks.push({ name: "视觉复核", ok: false, detail: "视觉模型发现问题（" + images.length + " 页）" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        code: "vision",
        severity: "info",
        message: "视觉复核失败（不阻塞自动检查）：" + message,
      });
      checks.push({ name: "视觉复核", ok: true, detail: "视觉复核失败，跳过（不算失败）" });
    }
  }
}
