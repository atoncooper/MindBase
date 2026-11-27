import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createLogger } from "../../logger.js";
import type { CommandRunner } from "./process.js";
import { HttpPdfRenderer } from "./http-pdf-renderer.js";

const log = createLogger("OFFICE-RENDER");

/**
 * Office -> page images, the "visual" half of document understanding.
 *
 * Two-step pipeline, both steps are external binaries:
 *   1. soffice --headless --convert-to pdf   (LibreOffice; preserves layout)
 *   2. pdftoppm -r <dpi> -png                (poppler; rasterizes one PNG per page)
 *
 * Why not a JS renderer: faithful layout for DOCX/XLSX/PPTX requires a real
 * layout engine. Every pure-JS option either ignores pagination or only handles
 * one format, so the deployment ships LibreOffice behind a build flag instead of
 * pretending a heuristic is a preview.
 *
 * Failure direction: the port is *available or not*. When the binaries are
 * missing the service reports a readable degradation message (structure text
 * still works), never a crash; a conversion error is a per-call error text.
 */

export interface RenderInput {
  /** Original file name (extension is only used for temp naming/logging). */
  fileName: string;
  bytes: Uint8Array;
  /** 1-based page ids to keep; omitted = first maxPages pages. */
  pages?: number[];
}

export interface RenderedPage {
  /** 1-based page number inside the source document. */
  page: number;
  png: Uint8Array;
}

export type RenderErrorCode = "unavailable" | "timeout" | "failed" | "too_large";

export class OfficeRenderError extends Error {
  constructor(
    readonly code: RenderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OfficeRenderError";
  }
}

/** Result of DOCX/Office -> PDF conversion (the audit pipeline's first hop). */
export interface PdfConversion {
  /** Raw PDF bytes produced by LibreOffice. */
  data: Uint8Array;
  /** Best-effort page count parsed from the PDF page tree; undefined when unknown. */
  pageCount?: number;
}

export interface OfficeRenderPort {
  readonly available: boolean;
  /** Present when unavailable: the exact reason to show the model/user. */
  readonly unavailableReason?: string;
  render(input: RenderInput, opts?: { maxPages?: number; timeoutMs?: number; dpi?: number }): Promise<RenderedPage[]>;
  /**
   * Optional Office -> PDF conversion, used by the rendering QA pipeline
   * (DOCX -> PDF -> poppler checks). Optional so every existing fake/port
   * implementation stays source-compatible; callers must feature-detect it.
   */
  convertToPdf?(
    input: { fileName: string; bytes: Uint8Array },
    opts?: { timeoutMs?: number },
  ): Promise<PdfConversion>;
}

export interface SofficeRendererOptions {
  runner: CommandRunner;
  /** Absolute path or bare name resolved from PATH. */
  sofficePath: string;
  pdftoppmPath: string;
  /** Source size ceiling in bytes. */
  maxSourceBytes: number;
  defaultTimeoutMs: number;
  defaultDpi: number;
  defaultMaxPages: number;
}

const EXT_BY_MIME: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/** Best-effort extension: mime first, then the provided name, then .bin. */
function extensionFor(fileName: string, mime?: string): string {
  if (mime && EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  const ext = path.extname(fileName).replace(/^\./, "").toLowerCase();
  if (/^(docx|xlsx|pptx)$/.test(ext)) return ext;
  return "bin";
}

export class SofficeRenderer implements OfficeRenderPort {
  constructor(private readonly options: SofficeRendererOptions) {}

  get available(): boolean {
    return true;
  }

  async render(
    input: RenderInput,
    opts: { maxPages?: number; timeoutMs?: number; dpi?: number } = {},
  ): Promise<RenderedPage[]> {
    if (input.bytes.byteLength === 0) throw new OfficeRenderError("failed", "文件为空，无法渲染");
    if (input.bytes.byteLength > this.options.maxSourceBytes) {
      throw new OfficeRenderError(
        "too_large",
        "文件超过渲染上限（" + Math.round(this.options.maxSourceBytes / 1024 / 1024) + "MB），请改用结构文本查看",
      );
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "office-render-"));
    const maxPages = Math.max(1, opts.maxPages ?? this.options.defaultMaxPages);
    const timeoutMs = Math.max(5_000, opts.timeoutMs ?? this.options.defaultTimeoutMs);
    const dpi = Math.max(48, Math.min(220, opts.dpi ?? this.options.defaultDpi));
    try {
      const pdf = await this.convertInDirectory(input, dir, timeoutMs);

      const prefix = path.join(dir, "page");
      const raster = await this.options.runner.run({
        command: this.options.pdftoppmPath,
        args: ["-r", String(dpi), "-png", "-f", "1", "-l", String(maxPages), pdf, prefix],
        cwd: dir,
        env: { HOME: dir, TMPDIR: dir },
        timeoutMs,
      });
      if (raster.timedOut) throw new OfficeRenderError("timeout", "PDF 转图片超时");

      const produced = (await fs.readdir(dir))
        .map((name) => /^page-(\d+)\.png$/.exec(name))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => ({ page: Number(match[1]), file: path.join(dir, match[0]) }))
        .sort((a, b) => a.page - b.page);
      const wanted = input.pages && input.pages.length > 0 ? new Set(input.pages) : undefined;
      const selected = produced.filter((item) => (wanted ? wanted.has(item.page) : true)).slice(0, maxPages);
      if (selected.length === 0) {
        throw new OfficeRenderError(
          "failed",
          "PDF 转图片失败：" + (raster.stderr.trim() || "未生成任何页面图片"),
        );
      }
      const pages: RenderedPage[] = [];
      for (const item of selected) {
        pages.push({ page: item.page, png: new Uint8Array(await fs.readFile(item.file)) });
      }
      log.info("[OFFICE-RENDER] rendered pages=%d file=%s dpi=%d", pages.length, input.fileName, dpi);
      return pages;
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * DOCX/Office -> PDF only (no rasterization). Used by the DOCX QA pipeline,
   * which then runs poppler text/font/image checks on the PDF. Shares the temp
   * dir + soffice profile handling with render() so both paths behave the same.
   */
  async convertToPdf(
    input: { fileName: string; bytes: Uint8Array },
    opts: { timeoutMs?: number } = {},
  ): Promise<PdfConversion> {
    if (input.bytes.byteLength === 0) throw new OfficeRenderError("failed", "文件为空，无法转换");
    if (input.bytes.byteLength > this.options.maxSourceBytes) {
      throw new OfficeRenderError(
        "too_large",
        "文件超过渲染上限（" + Math.round(this.options.maxSourceBytes / 1024 / 1024) + "MB），请改用结构文本查看",
      );
    }
    const timeoutMs = Math.max(5_000, opts.timeoutMs ?? this.options.defaultTimeoutMs);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "office-pdf-"));
    try {
      const pdfPath = await this.convertInDirectory(input, dir, timeoutMs);
      const data = new Uint8Array(await fs.readFile(pdfPath));
      if (data.byteLength === 0) throw new OfficeRenderError("failed", "转 PDF 失败：生成的 PDF 为空");
      log.info("[OFFICE-RENDER] converted to pdf bytes=%d file=%s", data.byteLength, input.fileName);
      return { data, pageCount: countPdfPages(data) };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Writes the source into `dir` and runs soffice --convert-to pdf; returns the PDF path. */
  private async convertInDirectory(
    input: { fileName: string; bytes: Uint8Array },
    dir: string,
    timeoutMs: number,
  ): Promise<string> {
    const source = path.join(dir, "source." + extensionFor(input.fileName));
    await fs.writeFile(source, Buffer.from(input.bytes));

    // A dedicated user profile keeps concurrent renders from fighting over the
    // single soffice lock file (the classic "first render works, later ones hang").
    const profile = path.join(dir, "profile");
    const conversion = await this.options.runner.run({
      command: this.options.sofficePath,
      args: [
        "-env:UserInstallation=file://" + profile.replace(/\\/g, "/"),
        "--headless",
        "--norestore",
        "--invisible",
        "--convert-to",
        "pdf",
        "--outdir",
        dir,
        source,
      ],
      cwd: dir,
      env: { HOME: dir, TMPDIR: dir },
      timeoutMs,
    });
    if (conversion.timedOut) throw new OfficeRenderError("timeout", "Office 转 PDF 超时");
    const pdf = path.join(dir, "source.pdf");
    if (!(await exists(pdf))) {
      throw new OfficeRenderError(
        "failed",
        "转 PDF 失败：" + (conversion.stderr.trim() || conversion.stdout.trim() || "soffice 未生成输出"),
      );
    }
    return pdf;
  }
}

/**
 * Best-effort page count from a PDF's page tree ("/Type /Page" objects).
 * Object streams may hide the tree, so callers must treat undefined as unknown.
 */
export function countPdfPages(data: Uint8Array): number | undefined {
  const text = Buffer.from(data).toString("latin1");
  const matches = text.match(/\/Type\s*\/Page(?![s\w])/g);
  return matches && matches.length > 0 ? matches.length : undefined;
}

/** Renderer used when the deployment has no LibreOffice/poppler. */
export class UnavailableRenderer implements OfficeRenderPort {
  readonly available = false;

  constructor(readonly unavailableReason: string) {}

  async render(): Promise<RenderedPage[]> {
    throw new OfficeRenderError("unavailable", this.unavailableReason);
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locates a binary: explicit config path first, then PATH lookup.
 * Deliberately side-effect free (no spawn) so boot never blocks on the renderer.
 */
export async function resolveBinary(configured: string, name: string): Promise<string | undefined> {
  if (configured.trim() !== "") {
    return (await exists(configured.trim())) ? configured.trim() : undefined;
  }
  const entries = (process.env.PATH ?? "").split(path.delimiter).filter((entry) => entry !== "");
  for (const dir of entries) {
    for (const candidate of [name, name + ".exe"]) {
      const full = path.join(dir, candidate);
      if (await exists(full)) return full;
    }
  }
  return undefined;
}

/** Builds the renderer from config; missing binaries degrade to UnavailableRenderer. */
export async function createOfficeRenderer(options: {
  runner: CommandRunner;
  enabled: boolean;
  /** "soffice" (in-image LibreOffice) or "http" (remote converter, e.g. Gotenberg). */
  backend?: "soffice" | "http";
  httpUrl?: string;
  httpEndpoint?: string;
  httpTimeoutMs?: number;
  sofficePath: string;
  pdftoppmPath: string;
  timeoutMs: number;
  dpi: number;
  maxPages: number;
  maxSourceBytes: number;
}): Promise<OfficeRenderPort> {
  if (!options.enabled) {
    return new UnavailableRenderer(
      "版面渲染未启用（OFFICERENDER__ENABLED=false），只能看结构文本；需要逐页看图请开启渲染并安装 LibreOffice 或配置远程转换服务。",
    );
  }
  if (options.backend === "http") {
    const url = (options.httpUrl ?? "").trim();
    if (url === "") {
      return new UnavailableRenderer(
        "渲染后端配置为 http，但 OFFICERENDER__HTTP__URL 为空；请启动转换服务（如 Gotenberg）并配置地址。",
      );
    }
    return new HttpPdfRenderer({
      url,
      ...(options.httpEndpoint ? { endpoint: options.httpEndpoint } : {}),
      maxSourceBytes: options.maxSourceBytes,
      defaultTimeoutMs: options.httpTimeoutMs ?? options.timeoutMs,
      defaultDpi: options.dpi,
      defaultMaxPages: options.maxPages,
    });
  }
  const soffice = await resolveBinary(options.sofficePath, "soffice");
  if (!soffice) {
    return new UnavailableRenderer(
      "未找到 LibreOffice（soffice）；app 镜像默认不含 LO，请改用 http 后端（Gotenberg）或用 OFFICERENDER__SOFFICE_PATH 指定本机 soffice。",
    );
  }
  const pdftoppm = await resolveBinary(options.pdftoppmPath, "pdftoppm");
  if (!pdftoppm) {
    return new UnavailableRenderer(
      "未找到 pdftoppm（poppler-utils），无法把 PDF 转成图片；镜像需以 --build-arg WITH_OFFICE_RENDERER=1 构建，或用 OFFICERENDER__PDFTOPPM_PATH 指定路径。",
    );
  }
  return new SofficeRenderer({
    runner: options.runner,
    sofficePath: soffice,
    pdftoppmPath: pdftoppm,
    maxSourceBytes: options.maxSourceBytes,
    defaultTimeoutMs: options.timeoutMs,
    defaultDpi: options.dpi,
    defaultMaxPages: options.maxPages,
  });
}
