import { createLogger } from "../../logger.js";
import { PdfiumRasterizer, type PdfRasterizer } from "./pdf-raster.js";
import {
  OfficeRenderError,
  countPdfPages,
  type OfficeRenderPort,
  type PdfConversion,
  type RenderInput,
  type RenderedPage,
} from "./renderer.js";

const log = createLogger("OFFICE-RENDER");

/**
 * HTTP renderer: Office -> PDF through a remote conversion service (Gotenberg).
 *
 * The app image contains no system binaries: DOCX/XLSX/PPTX conversion happens
 * in the Gotenberg container, and PDF -> PNG rasterization uses the bundled
 * PDFium WASM npm package (PdfiumRasterizer). Deployment therefore needs only
 * npm dependencies plus an optional Gotenberg sidecar.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpPdfRendererOptions {
  /** Base URL, e.g. http://gotenberg:3000 */
  url: string;
  /** Conversion endpoint path (Gotenberg default). */
  endpoint?: string;
  /** Injected for tests. */
  fetchFn?: FetchLike;
  /** Injected for tests; defaults to PDFium WASM. */
  rasterizer?: PdfRasterizer;
  maxSourceBytes: number;
  defaultTimeoutMs: number;
  defaultDpi: number;
  defaultMaxPages: number;
}

function extensionFor(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return /^(docx|xlsx|pptx|doc|xls|ppt|odt|ods|odp)$/.test(ext) ? ext : "bin";
}

export class HttpPdfRenderer implements OfficeRenderPort {
  readonly available = true;
  private readonly fetchFn: FetchLike;
  private readonly rasterizer: PdfRasterizer;

  constructor(private readonly options: HttpPdfRendererOptions) {
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.rasterizer = options.rasterizer ?? new PdfiumRasterizer();
  }

  async convertToPdf(
    input: { fileName: string; bytes: Uint8Array },
    opts: { timeoutMs?: number } = {},
  ): Promise<PdfConversion> {
    if (input.bytes.byteLength === 0) throw new OfficeRenderError("failed", "文件为空，无法渲染");
    if (input.bytes.byteLength > this.options.maxSourceBytes) {
      throw new OfficeRenderError(
        "too_large",
        "文件超过渲染上限（" + Math.round(this.options.maxSourceBytes / 1024 / 1024) + "MB），请改用结构文本查看",
      );
    }
    const timeoutMs = opts.timeoutMs ?? this.options.defaultTimeoutMs;
    const endpoint =
      this.options.url.replace(/\/$/, "") + (this.options.endpoint ?? "/forms/libreoffice/convert");
    const form = new FormData();
    form.append("files", new Blob([Buffer.from(input.bytes)]), "source." + extensionFor(input.fileName));
    let response: Response;
    try {
      response = await this.fetchFn(endpoint, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const timedOut = /abort|timeout/i.test(message);
      throw new OfficeRenderError(
        timedOut ? "timeout" : "failed",
        timedOut ? "转换服务超时（" + timeoutMs + "ms）" : "无法连接转换服务：" + message,
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new OfficeRenderError(
        "failed",
        "转换服务返回 HTTP " + response.status + (detail ? "：" + detail.slice(0, 300) : ""),
      );
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0 || Buffer.from(data.subarray(0, 5)).toString("latin1") !== "%PDF-") {
      throw new OfficeRenderError("failed", "转换服务没有返回 PDF（检查 Gotenberg 地址与文件格式）");
    }
    return { data, pageCount: countPdfPages(data) };
  }

  async render(
    input: RenderInput,
    opts: { maxPages?: number; timeoutMs?: number; dpi?: number } = {},
  ): Promise<RenderedPage[]> {
    const pdf = await this.convertToPdf(
      { fileName: input.fileName, bytes: input.bytes },
      { timeoutMs: opts.timeoutMs },
    );
    try {
      const pages = await this.rasterizer.rasterize(pdf.data, {
        dpi: opts.dpi ?? this.options.defaultDpi,
        maxPages: Math.max(1, opts.maxPages ?? this.options.defaultMaxPages),
        ...(input.pages ? { pages: input.pages } : {}),
      });
      log.info("[HTTP-RENDER] rendered %d page(s) via %s", pages.length, this.options.url);
      return pages;
    } catch (err) {
      if (err instanceof OfficeRenderError) throw err;
      throw new OfficeRenderError(
        "failed",
        "PDF 转图片失败：" + (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}

/** True when the configured HTTP conversion service answers a health probe. */
export async function probeHttpRenderer(
  url: string,
  fetchFn: FetchLike = (input, init) => fetch(input, init),
): Promise<boolean> {
  try {
    const response = await fetchFn(url.replace(/\/$/, "") + "/health", { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}
