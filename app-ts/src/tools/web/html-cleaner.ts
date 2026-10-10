import { parseHTML } from "linkedom";
import { hostnameBlocked } from "./ssrf.js";

/**
 * HTML → readable text pipeline for the fetch_webpage tool (linkedom DOM, pure JS).
 *
 * Cleaning stages, in order:
 *   1. metadata extraction (title / meta description) before head removal;
 *   2. subtree removal: script/style/media/embed/form-control chrome tags, structural
 *      noise (nav/header/footer/aside/dialog), hidden elements ([hidden], aria-hidden,
 *      display:none/visibility:hidden inline styles), role-based chrome
 *      (navigation/banner/complementary/contentinfo), and class/id keyword heuristics
 *      (cookie banners, ads, social/share, newsletter, related-articles, breadcrumbs…);
 *   3. main-content preference: among `article / main / [role=main]` candidates, the
 *      longest one holding ≥ max(300, 25% of body text) wins; otherwise full body —
 *      so boilerplate-heavy blog/news pages collapse to their real content;
 *   4. structured text emission: headings → markdown `#`-levels, list items → `- `,
 *      table rows on their own lines with `|`-separated cells, block elements
 *      newline-delimited; whitespace collapsed.
 *
 * The parser decodes entities; no manual entity handling remains. Known limitation:
 * SPA shells (client-rendered pages) still yield little text without a headless browser.
 */

export interface ExtractedPage {
  title: string;
  description: string;
  text: string;
  links: string[];
}

/**
 * Minimal structural DOM surface the pipeline relies on. linkedom's own typings
 * are loose (`querySelectorAll(): any`, no global DOM lib in Node), so the
 * helpers below are typed against this interface and the parsed document is
 * cast once at the entry point.
 */
interface HtmlNode {
  readonly nodeType: number;
  readonly data?: string;
  readonly tagName?: string;
  readonly textContent?: string;
  readonly childNodes: Iterable<HtmlNode>;
  remove(): void;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  querySelector(selectors: string): HtmlNode | null;
  querySelectorAll(selectors: string): Iterable<HtmlNode>;
}

interface HtmlDocument extends HtmlNode {
  documentElement: HtmlNode | null;
}

const NOISE_TAGS =
  "script,style,noscript,template,svg,math,canvas,iframe,frame,frameset,object,embed,applet," +
  "video,audio,source,track,map,area,link,meta,base,title,form,input,button,select,option,optgroup," +
  "textarea,label,fieldset,legend,datalist,output,nav,header,footer,aside,dialog";

/** high-precision class/id tokens — whole-token match after splitting on non-alphanumerics */
const NOISE_TOKENS = new Set([
  "cookie", "cookies", "consent", "gdpr",
  "ad", "ads", "advert", "adverts", "advertisement", "advertisements", "adsbygoogle", "adsense",
  "sponsored", "sponsor", "promo", "promotion",
  "banner", "newsletter", "subscribe", "subscription",
  "sidebar", "social", "share", "sharing", "sharebox",
  "comment", "comments", "commenting", "disqus",
  "related", "recommend", "recommended", "recommendations",
  "breadcrumb", "breadcrumbs", "popup", "popups", "modal", "tooltip", "tooltips",
  "hidden", "sr-only", "screen-reader", "skip-link", "masthead",
]);

const BLOCK_TAGS = new Set([
  "address", "article", "blockquote", "details", "dd", "div", "dl", "dt", "figcaption", "figure",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "main", "ol", "p", "pre", "section", "summary",
  "table", "tbody", "tfoot", "thead", "tr", "ul",
]);

const HEADING_LEVELS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

export function extractReadable(html: string, baseUrl: URL, linkLimit = 10): ExtractedPage {
  const document = parseHTML(html).document as unknown as HtmlDocument;

  // 1. metadata — read before the head is stripped with the rest of the chrome
  const title = collapseSpaces(document.querySelector("title")?.textContent ?? "").slice(0, 200);
  const description = collapseSpaces(
    document.querySelector('meta[name="description"]')?.getAttribute("content") ??
      document.querySelector('meta[property="og:description"]')?.getAttribute("content") ??
      "",
  ).slice(0, 300);

  // 2. strip noise subtrees
  for (const el of document.querySelectorAll(NOISE_TAGS)) el.remove();
  for (const el of document.querySelectorAll('[role="navigation"],[role="banner"],[role="complementary"],[role="contentinfo"]')) {
    el.remove();
  }
  for (const el of Array.from(document.querySelectorAll("*"))) {
    const style = (el.getAttribute("style") ?? "").toLowerCase();
    if (
      el.hasAttribute("hidden") ||
      el.getAttribute("aria-hidden") === "true" ||
      /display\s*:\s*none|visibility\s*:\s*hidden/.test(style)
    ) {
      el.remove();
      continue;
    }
    const tokens = `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    if (tokens.some((t) => NOISE_TOKENS.has(t))) el.remove();
  }

  // 3. main-content preference over the full body
  //    root = documentElement (not body): malformed pages without an explicit
  //    <body> keep their content as direct children of <html> in linkedom
  const root = document.documentElement ?? document;
  const bodyText = extractText(root);
  const text = collapseWhitespace(preferMain(document, bodyText));

  // 4. links from the cleaned DOM (nav/footer junk is already gone)
  const links = collectLinks(document, baseUrl, linkLimit);

  return { title, description, text, links };
}

function preferMain(document: HtmlDocument, bodyText: string): string {
  const candidates = Array.from(document.querySelectorAll("article, main, [role='main']"));
  if (candidates.length === 0) return bodyText;
  const threshold = Math.max(300, Math.floor(bodyText.length * 0.25));
  let best = "";
  for (const candidate of candidates) {
    const text = collapseWhitespace(extractText(candidate));
    if (text.length >= threshold && text.length > best.length) best = text;
  }
  return best || bodyText;
}

/** DOM → text with structure: headings → markdown levels, li → "- ", table rows + " | " cells. */
function extractText(root: HtmlNode | null): string {
  if (!root) return "";
  let out = "";
  const visit = (node: HtmlNode): void => {
    if (node.nodeType === 3) {
      out += node.data ?? "";
      return;
    }
    if (node.nodeType !== 1) return; // comments and other non-element nodes
    const el = node;
    const tag = (el.tagName ?? "").toLowerCase();
    if (tag === "br") {
      out += "\n";
      return;
    }
    const heading = HEADING_LEVELS[tag];
    if (heading) out += `\n${"#".repeat(heading)} `;
    else if (tag === "li") out += "\n- ";
    else if (tag === "tr") out += "\n";
    else if (BLOCK_TAGS.has(tag)) out += "\n";

    for (const child of Array.from(el.childNodes)) visit(child);

    if (tag === "td" || tag === "th") out += " | ";
    if (heading || BLOCK_TAGS.has(tag)) out += "\n";
  };
  for (const child of Array.from(root.childNodes)) visit(child);
  return out;
}

function collapseWhitespace(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collapseSpaces(raw: string): string {
  return decodeSpaces(raw).replace(/\s+/g, " ").trim();
}

/** textContent already decodes entities except &nbsp; → U+00A0, which reads badly in headers */
function decodeSpaces(raw: string): string {
  return raw.replace(/\u00a0/g, " ");
}

function collectLinks(document: HtmlDocument, baseUrl: URL, limit: number): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const a of document.querySelectorAll("a[href]")) {
    const href = (a.getAttribute("href") ?? "").trim();
    if (!href || href.startsWith("#")) continue;
    try {
      const abs = new URL(href, baseUrl);
      if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
      if (hostnameBlocked(abs.hostname)) continue;
      abs.hash = ""; // fragment-only variants are the same page
      const key = abs.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      links.push(key);
      if (links.length >= limit) break;
    } catch {
      continue;
    }
  }
  return links;
}
