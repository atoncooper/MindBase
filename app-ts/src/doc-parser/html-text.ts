import { parseHTML } from "linkedom";

/**
 * Document-HTML → structured text for the doc-parser: headings become markdown
 * levels, list items become "- " bullets, table rows keep "|"-separated cells,
 * block elements break lines. Used for docx (mammoth's HTML conversion) and
 * html/htm files so structure survives into chunking.
 *
 * Deliberately NOT the web cleaner (tools/web/html-cleaner.ts): document HTML is
 * machine-generated semantic markup — no ads/nav/cookie noise to strip, so this
 * walk preserves everything structural and nothing else.
 */

interface HtmlNode {
  readonly nodeType: number;
  readonly data?: string;
  readonly tagName?: string;
  readonly childNodes: Iterable<HtmlNode>;
}

const BLOCK_TAGS = new Set([
  "address", "article", "blockquote", "dd", "div", "dl", "dt", "figcaption", "figure",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "main", "ol", "p", "pre", "section",
  "table", "tbody", "tfoot", "thead", "tr", "ul",
]);

const HEADING_LEVELS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

export function htmlToStructuredText(html: string): string {
  const document = parseHTML(`<body>${html}</body>`).document as unknown as {
    documentElement: HtmlNode | null;
  };
  const root = document.documentElement;
  if (!root) return "";
  return collapse(extract(root));
}

function extract(root: HtmlNode): string {
  let out = "";
  const visit = (node: HtmlNode, inCell = false): void => {
    if (node.nodeType === 3) {
      out += node.data ?? "";
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = (el.tagName ?? "").toLowerCase();
    if (tag === "br") {
      out += "\n";
      return;
    }
    const heading = HEADING_LEVELS[tag];
    // inside a table cell, block children stay inline (mammoth wraps cell text in <p>)
    const block = BLOCK_TAGS.has(tag) && !inCell;
    if (heading) out += `\n${"#".repeat(heading)} `;
    else if (tag === "li") out += "\n- ";
    else if (tag === "tr") out += "\n";
    else if (block) out += "\n";

    for (const child of Array.from(el.childNodes)) visit(child, tag === "td" || tag === "th");

    if (tag === "td" || tag === "th") out += " | ";
    if (heading || block) out += "\n";
  };
  for (const child of Array.from(root.childNodes)) visit(child);
  return out;
}

function collapse(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
