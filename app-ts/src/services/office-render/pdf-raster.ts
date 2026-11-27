import { deflateSync } from "node:zlib";

import type { RenderedPage } from "./renderer.js";

/**
 * PDF -> PNG rasterization without system binaries (npm-only deployment).
 * Office -> PDF is delegated to Gotenberg; this turns the PDF into page images
 * for the vision model / page previews using PDFium WASM (@hyzyla/pdfium, MIT).
 */

export interface PdfRasterizeOptions {
  dpi: number;
  maxPages: number;
  pages?: number[];
}

export interface PdfRasterizer {
  rasterize(pdf: Uint8Array, options: PdfRasterizeOptions): Promise<RenderedPage[]>;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Encodes raw RGBA pixels as a PNG (8-bit, no interlace) using node:zlib. */
export function encodePngRgba(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (width <= 0 || height <= 0) throw new Error("PNG 尺寸不合法");
  if (rgba.byteLength < width * height * 4) throw new Error("PNG 像素数据不足");
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

interface PdfiumPage {
  render(options: {
    scale: number;
    render: (fragment: { data: Uint8Array; width: number; height: number }) => Promise<Uint8Array>;
  }): Promise<{ data: Uint8Array }>;
  close(): void;
}

interface PdfiumDocument {
  getPageCount(): number;
  getPage(index: number): PdfiumPage;
  destroy?(): void;
}

interface PdfiumLibrary {
  loadDocument(bytes: Uint8Array): Promise<PdfiumDocument>;
}

let libraryPromise: Promise<PdfiumLibrary> | undefined;

function getLibrary(): Promise<PdfiumLibrary> {
  libraryPromise ??= import("@hyzyla/pdfium").then(
    (module) => module.PDFiumLibrary.init() as unknown as Promise<PdfiumLibrary>,
  );
  return libraryPromise;
}

/** PDFium WASM rasterizer; initialized once and reused. */
export class PdfiumRasterizer implements PdfRasterizer {
  readonly available = true;

  async rasterize(pdf: Uint8Array, options: PdfRasterizeOptions): Promise<RenderedPage[]> {
    if (pdf.byteLength === 0) throw new Error("PDF 为空");
    const library = await getLibrary();
    const document = await library.loadDocument(pdf);
    try {
      const total = document.getPageCount();
      if (total <= 0) throw new Error("PDF 没有页面");
      const wanted = options.pages ? new Set(options.pages) : undefined;
      const maxPages = Math.max(1, options.maxPages);
      const scale = Math.max(0.25, options.dpi / 72);
      const pages: RenderedPage[] = [];
      for (let index = 0; index < total && pages.length < maxPages; index += 1) {
        const pageNumber = index + 1;
        if (wanted && !wanted.has(pageNumber)) continue;
        const page = document.getPage(index);
        try {
          const image = await page.render({
            scale,
            render: async (fragment) => encodePngRgba(fragment.data, fragment.width, fragment.height),
          });
          pages.push({ page: pageNumber, png: image.data });
        } finally {
          page.close();
        }
      }
      if (pages.length === 0) throw new Error("所选页码超出 PDF 范围（共 " + total + " 页）");
      return pages;
    } finally {
      document.destroy?.();
    }
  }
}


