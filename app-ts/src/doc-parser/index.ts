/** Document parser: filename extension dispatch → plain text. Unsupported types throw with a clear reason. */
import JSZip from "jszip";
import { isImageDocument, imageMimeFor, OcrError, type OcrClient } from "./ocr.js";
import { htmlToStructuredText } from "./html-text.js";

export interface ParsedDocument {
  text: string;
  mime: string;
}

export class UnsupportedDocumentError extends Error {
  constructor(filename: string, reason?: string) {
    super(
      `不支持的文档类型: ${filename}（支持 pdf / docx / pptx / txt / md / html / 图片[需OCR]）` +
        (reason ? `：${reason}` : ""),
    );
  }
}

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "html", "htm", "pdf", "docx", "pptx"]);

/** Whether parseDocument can handle this filename (images additionally require an enabled OCR client). */
export function isSupportedDocument(filename: string, ocrEnabled: boolean): boolean {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return TEXT_EXTENSIONS.has(ext) || (ocrEnabled && isImageDocument(filename));
}

export async function parseDocument(
  filename: string,
  buffer: Buffer,
  ocr?: OcrClient,
): Promise<ParsedDocument> {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  // image documents go through OCR (requires an enabled OcrClient)
  if (isImageDocument(filename)) {
    if (!ocr?.enabled) {
      throw new OcrError("disabled", "OCR 未启用（OCR__ENABLED=false），无法识别图片文档；请改传含文本层的 pdf/docx/txt/md/html");
    }
    const mime = imageMimeFor(filename);
    return { text: await ocr.recognize(filename, buffer, mime), mime };
  }
  switch (ext) {
    case "txt":
    case "md":
    case "markdown":
      return { text: buffer.toString("utf-8"), mime: "text/plain" };
    case "html":
    case "htm":
      return { text: htmlToStructuredText(buffer.toString("utf-8")), mime: "text/html" };
    case "pdf":
      return { text: await parsePdf(buffer), mime: "application/pdf" };
    case "docx":
      return { text: await parseDocx(buffer), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    case "pptx":
      return { text: await parsePptx(buffer), mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
    default:
      throw new UnsupportedDocumentError(filename);
  }
}

/** pdf-parse has no types and its ESM entry runs debug code; load the lib entry via createRequire. */
async function parsePdf(buffer: Buffer): Promise<string> {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
    buf: Buffer,
  ) => Promise<{ text: string }>;
  const res = await pdfParse(buffer);
  // pdf-parse joins pages with form feeds — page breaks are useful chunk boundaries
  const text = res.text.replace(/\f/g, "\n\n").trim();
  if (!text) {
    throw new UnsupportedDocumentError("PDF", "未提取到文本层（可能是扫描件/图片型 PDF，暂不支持）");
  }
  return text;
}

/** docx via mammoth's HTML conversion (headings/lists/tables) → structured text. */
async function parseDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const res = await mammoth.convertToHtml({ buffer });
  return htmlToStructuredText(res.value);
}

/**
 * pptx: OOXML zip — slides live at ppt/slides/slide{N}.xml, text runs in <a:t>
 * inside <a:p> paragraphs. Slide numbering is sorted NUMERICALLY (lexicographic
 * sort would put slide10 before slide2). Legacy binary .ppt is not supported.
 */
async function parsePptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer).catch(() => {
    throw new UnsupportedDocumentError("PPTX", "文件不是有效的 OOXML 压缩包（可能已损坏或是旧版二进制 .ppt）");
  });
  const slideNumbers = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .map((p) => Number(p.match(/(\d+)\.xml$/)![1]))
    .sort((a, b) => a - b);
  if (slideNumbers.length === 0) {
    throw new UnsupportedDocumentError("PPTX", "压缩包内没有幻灯片");
  }

  const slides: string[] = [];
  for (const n of slideNumbers) {
    const xml = await zip.files[`ppt/slides/slide${n}.xml`].async("string");
    const paragraphs = xml
      .split(/<\/a:p>/)
      .map((p) =>
        Array.from(p.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g))
          .map((m) => decodeXmlEntities(m[1]))
          .join("")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter(Boolean);
    if (paragraphs.length > 0) {
      slides.push(`# 幻灯片 ${n}\n\n${paragraphs.join("\n")}`);
    }
  }
  if (slides.length === 0) {
    throw new UnsupportedDocumentError("PPTX", "幻灯片里没有文本（可能是纯图片幻灯片，暂不支持）");
  }
  return slides.join("\n\n");
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&"); // ampersand last — it encodes the other escapes
}
