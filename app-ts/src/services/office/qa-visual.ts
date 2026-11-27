import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CommandRunner } from "../office-render/process.js";
import type { OfficeRenderPort } from "../office-render/renderer.js";
import { parseBboxLayout, type BboxPage } from "./qa.js";

/**
 * Visual regression for rendered Word documents.
 *
 * The DOCX builder can be checked without any Office binary (structure audit),
 * but visual regressions — a caption jumping above the figure, a footnote
 * landing on the wrong page, a cover band no longer bleeding to the paper edge —
 * only show up after a real layout engine paginates the document. The pipeline
 * mirrors the QA pipeline:
 *
 *   docx -> OfficeRenderPort.convertToPdf -> pdftotext -bbox-layout
 *        -> normalized snapshot (text + coordinates + glyph height)
 *        -> compare with a golden JSON in test/golden/office/
 *
 * The snapshot is deliberately layout-tool-agnostic: page size in points,
 * word text, x/y of the box and its height (the closest thing poppler offers to
 * a font size). Coordinates are rounded, so LibreOffice minor-version jitter
 * does not flap the comparison; tolerance knobs live in VisualDiffOptions.
 *
 * Failure direction: a missing renderer or poppler is "unavailable" (exit code
 * 2), never a fake pass. A real difference is exit code 1.
 */

export const VISUAL_SNAPSHOT_VERSION = 1 as const;

export const VISUAL_EXIT = {
  /** Snapshot matches the golden (or --update wrote it). */
  ok: 0,
  /** The document renders differently from the golden. */
  diff: 1,
  /** No LibreOffice / poppler / PDF conversion: the check did not run. */
  unavailable: 2,
} as const;

export type VisualExitCode = (typeof VISUAL_EXIT)[keyof typeof VISUAL_EXIT];

/** One normalized word box: text, page coordinates (pt) and height as size proxy. */
export interface VisualWord {
  text: string;
  x: number;
  y: number;
  /** Box height in points; poppler does not expose the font size directly. */
  size: number;
}

export interface VisualPage {
  /** 1-based page number. */
  page: number;
  widthPt: number;
  heightPt: number;
  words: VisualWord[];
}

export interface VisualSnapshot {
  version: typeof VISUAL_SNAPSHOT_VERSION;
  /** First page geometry; 0 when pdftotext reported none. */
  pageSize: { widthPt: number; heightPt: number };
  pages: VisualPage[];
}

export interface SnapshotOptions {
  /** Decimal places kept for coordinates/sizes (default 1 = 0.1pt). */
  precision?: number;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** pdftotext -bbox-layout pages -> deterministic, JSON-serializable snapshot. */
export function normalizeSnapshot(pages: BboxPage[], options: SnapshotOptions = {}): VisualSnapshot {
  const precision = options.precision ?? 1;
  const normalized: VisualPage[] = pages.map((page) => ({
    page: page.page,
    widthPt: round(page.widthPt, precision),
    heightPt: round(page.heightPt, precision),
    words: page.words
      .map((word) => ({
        text: collapse(word.text),
        x: round(word.xMin, precision),
        y: round(word.yMin, precision),
        size: round(word.yMax - word.yMin, precision),
      }))
      .filter((word) => word.text !== ""),
  }));
  return {
    version: VISUAL_SNAPSHOT_VERSION,
    pageSize: normalized[0]
      ? { widthPt: normalized[0].widthPt, heightPt: normalized[0].heightPt }
      : { widthPt: 0, heightPt: 0 },
    pages: normalized,
  };
}

export interface VisualDiffOptions {
  /** Allowed per-word x/y drift in points (default 1.5). */
  positionTolerancePt?: number;
  /** Allowed per-word height (size proxy) drift in points (default 1.2). */
  sizeTolerancePt?: number;
  /** Minimum per-page text similarity (Dice coefficient of bigrams; default 0.995). */
  textSimilarity?: number;
  /** Max issues collected per page (default 5) and overall (default 20). */
  maxIssuesPerPage?: number;
  maxIssues?: number;
}

export interface VisualPageDiff {
  page: number;
  textSimilarity: number;
  wordCount: { expected: number; actual: number };
  positionDrifts: number;
  sizeDrifts: number;
  issues: string[];
}

export interface VisualDiff {
  pass: boolean;
  pageCount: { expected: number; actual: number };
  pages: VisualPageDiff[];
  issues: string[];
}

/** Dice coefficient over character bigrams (robust to one-word reflow). */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const grams = (value: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (let index = 0; index + 1 < value.length; index += 1) {
      const gram = value.slice(index, index + 2);
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };
  const left = grams(a);
  const right = grams(b);
  let overlap = 0;
  for (const [gram, count] of left) {
    const other = right.get(gram);
    if (other !== undefined) overlap += Math.min(count, other);
  }
  const total = left.size + right.size;
  return total === 0 ? 0 : (2 * overlap) / total;
}

function pageText(page: VisualPage): string {
  return page.words.map((word) => word.text).join(" ");
}

/** Compares a golden snapshot with a fresh one; pass = no textual/layout drift. */
export function diffSnapshots(
  expected: VisualSnapshot,
  actual: VisualSnapshot,
  options: VisualDiffOptions = {},
): VisualDiff {
  const positionTolerance = options.positionTolerancePt ?? 1.5;
  const sizeTolerance = options.sizeTolerancePt ?? 1.2;
  const minSimilarity = options.textSimilarity ?? 0.995;
  const maxIssuesPerPage = options.maxIssuesPerPage ?? 5;
  const maxIssues = options.maxIssues ?? 20;

  const issues: string[] = [];
  const pages: VisualPageDiff[] = [];
  if (expected.pages.length !== actual.pages.length) {
    issues.push("页数不一致：golden " + expected.pages.length + " 页，实际 " + actual.pages.length + " 页");
  }
  const total = Math.min(expected.pages.length, actual.pages.length);
  for (let index = 0; index < total; index += 1) {
    const expectedPage = expected.pages[index] as VisualPage;
    const actualPage = actual.pages[index] as VisualPage;
    const pageIssues: string[] = [];
    const similarity = textSimilarity(pageText(expectedPage), pageText(actualPage));
    const wordCount = { expected: expectedPage.words.length, actual: actualPage.words.length };
    let positionDrifts = 0;
    let sizeDrifts = 0;

    if (Math.abs(expectedPage.widthPt - actualPage.widthPt) > 1 || Math.abs(expectedPage.heightPt - actualPage.heightPt) > 1) {
      pageIssues.push(
        "第 " + actualPage.page + " 页尺寸变化：" +
          expectedPage.widthPt + "×" + expectedPage.heightPt + "pt -> " +
          actualPage.widthPt + "×" + actualPage.heightPt + "pt",
      );
    }
    if (similarity < minSimilarity) {
      pageIssues.push(
        "第 " + actualPage.page + " 页文本不一致（相似度 " + (similarity * 100).toFixed(2) + "%）",
      );
    } else if (wordCount.expected !== wordCount.actual) {
      pageIssues.push(
        "第 " + actualPage.page + " 页词数变化：" + wordCount.expected + " -> " + wordCount.actual,
      );
    } else {
      for (let wordIndex = 0; wordIndex < expectedPage.words.length; wordIndex += 1) {
        const goldenWord = expectedPage.words[wordIndex] as VisualWord;
        const word = actualPage.words[wordIndex] as VisualWord;
        const dx = Math.abs(goldenWord.x - word.x);
        const dy = Math.abs(goldenWord.y - word.y);
        if (dx > positionTolerance || dy > positionTolerance) {
          positionDrifts += 1;
          if (pageIssues.length < maxIssuesPerPage) {
            pageIssues.push(
              "第 " + actualPage.page + " 页「" + word.text + "」位置偏移 " +
                "dx=" + dx.toFixed(1) + "pt dy=" + dy.toFixed(1) + "pt",
            );
          }
        }
        if (Math.abs(goldenWord.size - word.size) > sizeTolerance) {
          sizeDrifts += 1;
          if (pageIssues.length < maxIssuesPerPage) {
            pageIssues.push(
              "第 " + actualPage.page + " 页「" + word.text + "」字号变化 " +
                goldenWord.size.toFixed(1) + "pt -> " + word.size.toFixed(1) + "pt",
            );
          }
        }
      }
    }

    pages.push({
      page: actualPage.page,
      textSimilarity: Math.round(similarity * 10_000) / 10_000,
      wordCount,
      positionDrifts,
      sizeDrifts,
      issues: pageIssues,
    });
    for (const issue of pageIssues) {
      if (issues.length < maxIssues) issues.push(issue);
    }
  }

  return {
    pass: issues.length === 0,
    pageCount: { expected: expected.pages.length, actual: actual.pages.length },
    pages,
    issues,
  };
}

/** The environment cannot produce a snapshot at all (no renderer / no poppler). */
export class VisualRegressionUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "VisualRegressionUnavailableError";
  }
}

export interface VisualCaptureDeps {
  renderer: OfficeRenderPort;
  runner: CommandRunner;
  /** pdftotext binary (absolute path or bare name resolved from PATH). */
  pdftotextPath?: string;
  /** Whole DOCX->PDF->text budget (default 60s). */
  timeoutMs?: number;
}

export interface VisualCaptureInput {
  fileName: string;
  bytes: Uint8Array;
  /** Pre-converted PDF (offline/Word-COM workflows); skips the renderer step. */
  pdf?: Uint8Array;
}

/**
 * Renders a DOCX to PDF and parses it with pdftotext -bbox-layout.
 * Throws VisualRegressionUnavailableError for every environmental gap so the
 * caller can map it to exit code 2 instead of reporting a false difference.
 */
export async function captureVisualSnapshot(
  deps: VisualCaptureDeps,
  input: VisualCaptureInput,
  options: { tmpRoot?: string } = {},
): Promise<VisualSnapshot> {
  if (!deps.renderer.available) {
    throw new VisualRegressionUnavailableError(deps.renderer.unavailableReason ?? "版面渲染器不可用");
  }
  const convert = deps.renderer.convertToPdf;
  if (typeof convert !== "function") {
    throw new VisualRegressionUnavailableError("当前渲染器不支持 DOCX→PDF 转换，无法做视觉回归");
  }
  const timeoutMs = deps.timeoutMs ?? 60_000;
  let pdf: Uint8Array;
  try {
    const conversion = await convert.call(deps.renderer, { fileName: input.fileName, bytes: input.bytes }, { timeoutMs });
    pdf = conversion.data;
  } catch (err) {
    throw new VisualRegressionUnavailableError(
      "DOCX 转 PDF 失败：" + (err instanceof Error ? err.message : String(err)),
    );
  }
  if (pdf.byteLength === 0) throw new VisualRegressionUnavailableError("DOCX 转 PDF 失败：PDF 为空");

  return snapshotFromPdf(deps, pdf, options);
}

/**
 * Parses already-converted PDF bytes with pdftotext (no renderer needed).
 * Used by offline golden generation (e.g. Word COM converted PDFs on Windows)
 * and by tests.
 */
export async function snapshotFromPdf(
  deps: Pick<VisualCaptureDeps, "runner" | "pdftotextPath" | "timeoutMs">,
  pdf: Uint8Array,
  options: { tmpRoot?: string } = {},
): Promise<VisualSnapshot> {
  if (pdf.byteLength === 0) throw new VisualRegressionUnavailableError("PDF 为空，无法生成快照");
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const dir = await fs.mkdtemp(path.join(options.tmpRoot ?? os.tmpdir(), "office-visual-"));
  try {
    const pdfPath = path.join(dir, "snapshot.pdf");
    await fs.writeFile(pdfPath, Buffer.from(pdf));
    const result = await deps.runner.run({
      command: deps.pdftotextPath ?? "pdftotext",
      args: ["-bbox-layout", pdfPath, "-"],
      cwd: dir,
      timeoutMs,
    });
    if (result.timedOut) throw new VisualRegressionUnavailableError("pdftotext 超时");
    if (result.code !== 0) {
      throw new VisualRegressionUnavailableError(
        "pdftotext 调用失败（poppler 不可用？）：" + (result.stderr.trim() || "未知错误"),
      );
    }
    const pages = parseBboxLayout(result.stdout);
    if (pages.length === 0) {
      throw new VisualRegressionUnavailableError("PDF 未解析到任何页面（pdftotext -bbox-layout 输出为空）");
    }
    return normalizeSnapshot(pages);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export type VisualCaseStatus = "pass" | "fail" | "created" | "missing";

export interface VisualCaseResult {
  name: string;
  goldenPath: string;
  status: VisualCaseStatus;
  diff?: VisualDiff;
  issues: string[];
}

export interface VisualRegressionOptions {
  cases: VisualCaptureInput[];
  /** Directory holding <stem>.json goldens. */
  goldenDir: string;
  /** true = (re)write the golden instead of comparing. */
  update: boolean;
  deps: VisualCaptureDeps;
  diff?: VisualDiffOptions;
}

export interface VisualRegressionResult {
  exitCode: VisualExitCode;
  results: VisualCaseResult[];
  /** Set when the environment is missing a required binary; exitCode is 2 then. */
  unavailableReason?: string;
}

function goldenFileName(name: string): string {
  return name.replace(/\.docx$/i, "").replace(/[\\/:*?"<>|]/g, "_") + ".json";
}

/** Serializes a snapshot so --update output is stable in git (2-space, trailing newline). */
export function serializeSnapshot(snapshot: VisualSnapshot): string {
  return JSON.stringify(snapshot, null, 2) + "\n";
}

/**
 * Runs the whole compare loop over already-read .docx files.
 * Pure I/O at the edges: rendering/text extraction go through the injected
 * ports, so tests drive it with a fake renderer + fake command runner.
 */
export async function runVisualRegression(options: VisualRegressionOptions): Promise<VisualRegressionResult> {
  const results: VisualCaseResult[] = [];
  await fs.mkdir(options.goldenDir, { recursive: true });
  for (const testCase of options.cases) {
    const goldenPath = path.join(options.goldenDir, goldenFileName(testCase.fileName));
    let snapshot: VisualSnapshot;
    try {
      snapshot = testCase.pdf
        ? await snapshotFromPdf(options.deps, testCase.pdf)
        : await captureVisualSnapshot(options.deps, testCase);
    } catch (err) {
      if (err instanceof VisualRegressionUnavailableError) {
        return { exitCode: VISUAL_EXIT.unavailable, results, unavailableReason: err.reason };
      }
      throw err;
    }
    if (options.update) {
      await fs.writeFile(goldenPath, serializeSnapshot(snapshot), "utf8");
      results.push({ name: testCase.fileName, goldenPath, status: "created", issues: [] });
      continue;
    }
    let goldenRaw: string;
    try {
      goldenRaw = await fs.readFile(goldenPath, "utf8");
    } catch {
      results.push({
        name: testCase.fileName,
        goldenPath,
        status: "missing",
        issues: ["缺少 golden：" + goldenPath + "（用 --update 生成）"],
      });
      continue;
    }
    let golden: VisualSnapshot;
    try {
      golden = JSON.parse(goldenRaw) as VisualSnapshot;
    } catch {
      results.push({ name: testCase.fileName, goldenPath, status: "fail", issues: ["golden 不是合法 JSON：" + goldenPath] });
      continue;
    }
    const diff = diffSnapshots(golden, snapshot, options.diff ?? {});
    results.push({
      name: testCase.fileName,
      goldenPath,
      status: diff.pass ? "pass" : "fail",
      diff,
      issues: diff.issues,
    });
  }
  const failed = results.some((result) => result.status === "fail" || result.status === "missing");
  return { exitCode: failed ? VISUAL_EXIT.diff : VISUAL_EXIT.ok, results };
}
