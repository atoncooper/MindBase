import type { DocxBlock } from "./types.js";
import type { DocumentIR, IRBlock } from "./ir.js";

/**
 * Legacy block list (office_export 1.x schema) -> Document IR.
 *
 * Keeps the old tool contract working while every document now flows through the
 * IR + template + renderer pipeline: cover/kv/metrics/callout/divider keep their
 * intent, plain blocks map one-to-one.
 */
export function legacyBlocksToDocument(input: {
  title: string;
  subtitle?: string;
  blocks: DocxBlock[];
  template?: string;
  layout?: string;
  header?: string;
  footer?: string;
  toc?: boolean;
  cover?: boolean;
}): DocumentIR {
  const blocks: IRBlock[] = [];
  let coverFromBlock: { title: string; subtitle?: string; meta?: string[] } | undefined;

  for (const block of input.blocks) {
    switch (block.type) {
      case "heading":
        blocks.push({ type: "heading", level: block.level ?? 1, text: block.text });
        break;
      case "paragraph":
        blocks.push({ type: "paragraph", text: block.text, style: "body" });
        break;
      case "line":
        blocks.push({ type: "line", text: block.text });
        break;
      case "bullets":
        blocks.push({
          type: block.ordered ? "orderedList" : "unorderedList",
          items: block.items,
        });
        break;
      case "quote":
        blocks.push({ type: "quote", text: block.text });
        break;
      case "table":
        blocks.push({
          type: "table",
          ...(block.headers ? { headers: block.headers } : {}),
          rows: block.rows.map((row) => row.map((cell) => String(cell))),
          ...(block.caption ? { caption: block.caption } : {}),
          ...(block.widths ? { widths: block.widths } : {}),
        });
        break;
      case "kv":
        blocks.push({ type: "kv", items: block.items, ...(block.columns === 1 ? { columns: 1 } : {}) });
        break;
      case "metrics":
        blocks.push({ type: "metrics", items: block.items });
        break;
      case "callout":
        blocks.push({
          type: "callout",
          text: block.text,
          ...(block.title ? { title: block.title } : {}),
          ...(block.tone ? { tone: block.tone } : {}),
        });
        break;
      case "divider":
        blocks.push({ type: "divider" });
        break;
      case "cover":
        coverFromBlock = {
          title: block.title,
          ...(block.subtitle ? { subtitle: block.subtitle } : {}),
          ...(block.meta ? { meta: block.meta } : {}),
        };
        break;
      case "pageBreak":
        blocks.push({ type: "pageBreak" });
        break;
      default:
        break;
    }
  }

  const cover = input.cover ?? coverFromBlock !== undefined;
  const title = coverFromBlock?.title?.trim() || input.title;
  const subtitle = input.subtitle ?? coverFromBlock?.subtitle;
  return {
    version: 1,
    ...(input.template ?? input.layout ? { template: input.template ?? input.layout } : {}),
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(input.header ? { header: input.header } : {}),
    ...(input.footer ? { footer: input.footer } : {}),
    ...(input.toc !== undefined ? { toc: input.toc } : {}),
    cover,
    ...(coverFromBlock?.meta ? { coverMeta: coverFromBlock.meta } : {}),
    sections: [{ blocks }],
  };
}
