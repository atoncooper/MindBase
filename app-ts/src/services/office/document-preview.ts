import type { OfficeDocBlock } from "../../artifacts/office-document.js";
import type { DocxBlock } from "./types.js";
import type { DocumentIR, IRBlock } from "./ir.js";

/**
 * Block-spec -> preview blocks for a document that was just generated.
 *
 * The exporter already holds the exact structure it rendered, so the preview
 * needs no OOXML round-trip: inline emphasis is flattened (the card renders
 * plain text), empty blocks are dropped, and page breaks become separators.
 *
 * Two entry points: the legacy DocxBlock list (below) and the Document IR
 * (documentIRToPreviewBlocks), which also covers the constructs the legacy
 * shape never had — footnote marks become "[注] …" paragraphs and
 * cross-references become "见表 N / 见图 N" text, because a paper-like preview
 * cannot carry Word footnote/field parts.
 */

function plainText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

export function docxSpecToDocumentBlocks(blocks: DocxBlock[]): OfficeDocBlock[] {
  const out: OfficeDocBlock[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "heading": {
        const text = plainText(block.text);
        if (text) out.push({ type: "heading", level: block.level ?? 1, text });
        break;
      }
      case "paragraph":
      case "line": {
        const text = plainText(block.text);
        if (text) out.push({ type: "paragraph", text });
        break;
      }
      case "bullets": {
        const items = block.items.map(plainText).filter((item) => item !== "");
        if (items.length > 0) {
          out.push({ type: "bullets", items, ...(block.ordered ? { ordered: true } : {}) });
        }
        break;
      }
      case "quote": {
        const text = plainText(block.text);
        if (text) out.push({ type: "quote", text });
        break;
      }
      case "divider":
        break;
      case "cover": {
        const title = plainText(block.title);
        if (title) out.push({ type: "heading", level: 1, text: title });
        const subtitle = block.subtitle ? plainText(block.subtitle) : "";
        if (subtitle) out.push({ type: "paragraph", text: subtitle });
        for (const meta of block.meta ?? []) {
          const line = plainText(meta);
          if (line) out.push({ type: "paragraph", text: line });
        }
        break;
      }
      case "kv": {
        const rows = block.items.map((item) => [plainText(item.label), plainText(item.value)]);
        if (rows.length > 0) out.push({ type: "table", rows });
        break;
      }
      case "metrics": {
        const headers = block.items.map((item) => plainText(item.label));
        const values = block.items.map((item) => plainText(item.value));
        if (headers.length > 0) out.push({ type: "table", headers, rows: [values] });
        break;
      }
      case "callout": {
        const title = block.title ? plainText(block.title) : "";
        const text = plainText(block.text);
        const merged = title && text ? title + "：" + text : title || text;
        if (merged) out.push({ type: "quote", text: merged });
        break;
      }
      case "table": {
        const headers = (block.headers ?? []).map(plainText);
        const rows = block.rows.map((row) => row.map((cell) => plainText(String(cell))));
        if (rows.length > 0) {
          out.push({ type: "table", ...(headers.length > 0 ? { headers } : {}), rows });
        }
        break;
      }
      case "pageBreak":
        out.push({ type: "pageBreak" });
        break;
      default:
        break;
    }
  }
  return out;
}

/** IR -> preview blocks; footnote/crossReference are flattened to text lines. */
export function documentIRToPreviewBlocks(doc: DocumentIR): OfficeDocBlock[] {
  const out: OfficeDocBlock[] = [];
  for (const section of doc.sections) {
    if (section.heading) {
      const heading = plainText(section.heading);
      if (heading) out.push({ type: "heading", level: 1, text: heading });
    }
    for (const block of section.blocks) pushPreviewBlock(out, block);
  }
  return out;
}

function pushPreviewBlock(out: OfficeDocBlock[], block: IRBlock): void {
  switch (block.type) {
    case "heading": {
      const text = plainText(block.text);
      if (text) out.push({ type: "heading", level: block.level, text });
      break;
    }
    case "paragraph":
    case "line":
    case "caption":
    case "formula": {
      const text = plainText(block.text);
      if (text) out.push({ type: "paragraph", text });
      break;
    }
    case "orderedList":
    case "unorderedList": {
      const items = block.items.map(plainText).filter((item) => item !== "");
      if (items.length > 0) {
        out.push({ type: "bullets", items, ...(block.type === "orderedList" ? { ordered: true } : {}) });
      }
      break;
    }
    case "table": {
      const caption = block.caption ? plainText(block.caption) : "";
      if (caption) out.push({ type: "paragraph", text: caption });
      const headers = (block.headers ?? []).map(plainText);
      const rows = block.rows.map((row) => row.map((cell) => plainText(String(cell))));
      if (rows.length > 0) out.push({ type: "table", ...(headers.length > 0 ? { headers } : {}), rows });
      break;
    }
    case "image": {
      const label = plainText(block.caption ?? block.alt ?? "图片");
      out.push({ type: "paragraph", text: "【图】" + label });
      break;
    }
    case "quote": {
      const text = plainText(block.text);
      const cite = block.cite ? plainText(block.cite) : "";
      const merged = text && cite ? text + "（" + cite + "）" : text || cite;
      if (merged) out.push({ type: "quote", text: merged });
      break;
    }
    case "codeBlock": {
      const code = block.code.trim();
      if (code) out.push({ type: "paragraph", text: code });
      break;
    }
    case "footnote": {
      const text = plainText(block.text);
      if (text) out.push({ type: "paragraph", text: "[注] " + text });
      break;
    }
    case "endnote": {
      const text = plainText(block.text);
      if (text) out.push({ type: "paragraph", text: "[尾注] " + text });
      break;
    }
    case "crossReference": {
      const prefix = block.prefix ?? "见";
      const label =
        block.kind === "table" ? "表 " : block.kind === "figure" ? "图 " : block.kind === "heading" ? "标题 " : "公式 ";
      out.push({ type: "paragraph", text: prefix + label + block.index });
      break;
    }
    case "reference": {
      const items = block.items.map(plainText).filter((item) => item !== "");
      if (items.length > 0) out.push({ type: "bullets", items, ordered: true });
      break;
    }
    case "callout": {
      const title = block.title ? plainText(block.title) : "";
      const text = plainText(block.text);
      const merged = title && text ? title + "：" + text : title || text;
      if (merged) out.push({ type: "quote", text: merged });
      break;
    }
    case "kv": {
      const rows = block.items.map((item) => [plainText(item.label), plainText(item.value)]);
      if (rows.length > 0) out.push({ type: "table", rows });
      break;
    }
    case "metrics": {
      const headers = block.items.map((item) => plainText(item.label));
      const values = block.items.map((item) => plainText(item.value));
      if (headers.length > 0) out.push({ type: "table", headers, rows: [values] });
      break;
    }
    case "toc": {
      out.push({ type: "paragraph", text: "目录" });
      break;
    }
    case "pageBreak":
      out.push({ type: "pageBreak" });
      break;
    case "divider":
    case "sectionBreak":
      break;
    default:
      break;
  }
}

