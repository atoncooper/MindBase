import { describe, expect, it } from "vitest";

import { HttpPdfRenderer, type FetchLike } from "../src/services/office-render/http-pdf-renderer.js";
import { OfficeRenderError, type RenderInput, type RenderedPage } from "../src/services/office-render/renderer.js";
import type { PdfRasterizeOptions, PdfRasterizer } from "../src/services/office-render/pdf-raster.js";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\ntrailer\n%%EOF");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class FakeRasterizer implements PdfRasterizer {
  calls: PdfRasterizeOptions[] = [];
  constructor(private readonly pages: RenderedPage[] = [{ page: 1, png: PNG }, { page: 2, png: PNG }]) {}
  async rasterize(_pdf: Uint8Array, options: PdfRasterizeOptions): Promise<RenderedPage[]> {
    this.calls.push(options);
    const wanted = options.pages ? new Set(options.pages) : undefined;
    return this.pages.filter((page) => !wanted || wanted.has(page.page)).slice(0, options.maxPages);
  }
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): FetchLike {
  return (url, init) => handler(url, init);
}

function rendererWith(fetchFn: FetchLike, rasterizer: FakeRasterizer = new FakeRasterizer()) {
  return {
    rasterizer,
    renderer: new HttpPdfRenderer({
      url: "http://gotenberg:3000/",
      fetchFn,
      rasterizer,
      maxSourceBytes: 20 * 1024 * 1024,
      defaultTimeoutMs: 5_000,
      defaultDpi: 96,
      defaultMaxPages: 4,
    }),
  };
}

const input: RenderInput = { fileName: "a.docx", bytes: new Uint8Array(Buffer.from("docx")) };

describe("HttpPdfRenderer (Gotenberg + npm PDF rasterizer)", () => {
  it("posts multipart to /forms/libreoffice/convert and returns the PDF", async () => {
    let calledUrl = "";
    let calledBody: BodyInit | null | undefined;
    const { renderer } = rendererWith(
      fakeFetch(async (url, init) => {
        calledUrl = url;
        calledBody = init?.body;
        return new Response(PDF, { status: 200 });
      }),
    );
    const result = await renderer.convertToPdf(input);
    expect(calledUrl).toBe("http://gotenberg:3000/forms/libreoffice/convert");
    expect(calledBody).toBeInstanceOf(FormData);
    expect(Buffer.from(result.data).toString("latin1").startsWith("%PDF-")).toBe(true);
    expect(result.pageCount).toBe(1);
  });

  it("maps HTTP errors, empty bodies and oversized input", async () => {
    const failing = rendererWith(fakeFetch(async () => new Response("boom", { status: 500 })));
    await expect(failing.renderer.convertToPdf(input)).rejects.toMatchObject({ code: "failed" });

    const empty = rendererWith(fakeFetch(async () => new Response(new Uint8Array(), { status: 200 })));
    await expect(empty.renderer.convertToPdf(input)).rejects.toBeInstanceOf(OfficeRenderError);

    const tooLarge = rendererWith(fakeFetch(async () => new Response(PDF)));
    await expect(
      tooLarge.renderer.convertToPdf({ fileName: "a.docx", bytes: new Uint8Array(21 * 1024 * 1024) }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("maps timeouts to the timeout code", async () => {
    const { renderer } = rendererWith(
      fakeFetch(async () => {
        throw new DOMException("aborted due to timeout", "TimeoutError");
      }),
    );
    await expect(renderer.convertToPdf(input)).rejects.toMatchObject({ code: "timeout" });
  });

  it("rasterizes through the injected npm rasterizer and forwards page selection", async () => {
    const { renderer, rasterizer } = rendererWith(fakeFetch(async () => new Response(PDF)));
    const pages = await renderer.render({ ...input, pages: [2] }, { dpi: 120, maxPages: 3 });
    expect(pages.map((page) => page.page)).toEqual([2]);
    expect(rasterizer.calls[0]).toMatchObject({ dpi: 120, maxPages: 3, pages: [2] });
  });

  it("wraps rasterizer failures in a readable OfficeRenderError", async () => {
    const failing: PdfRasterizer = {
      async rasterize() {
        throw new Error("pdfium init failed");
      },
    };
    const { renderer } = rendererWith(fakeFetch(async () => new Response(PDF)), failing as never);
    await expect(renderer.render(input)).rejects.toMatchObject({ code: "failed" });
  });
});
