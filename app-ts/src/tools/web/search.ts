import { z } from "zod";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import { defineTool } from "../base.js";
import { createDeepSeekApiFromConfig } from "./deepseek.js";

const log = createLogger("WEB_SEARCH");

/**
 * web_search: keyless web search. Engines: Baidu (primary — the most reliable
 * source from CN networks, verified no captcha + relevant results from the
 * app-ts container) with Bing as fallback. Both engines are HTML-parsed with
 * structural markers (baidu result containers / bing b_algo blocks); Baidu
 * redirect links are HEAD-resolved to real targets; Bing /ck/a links are
 * base64-decoded. UA must look like a plain browser: Bing serves a degraded
 * result-less layout to bot-ish UAs (container-verified).
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_HTML_BYTES = 1_500_000;

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  /** DeepSeek 引擎独有：发布日期（date 截取 YYYY-MM-DD，未知省略） */
  publishedAt?: string;
  /** DeepSeek 引擎独有：权威层级 0-4（-1 未知时不展示） */
  authority?: number;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, "\u0022")
    .replace(/&#39;/g, "\u0027")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function unwrapBingRedirect(raw: string): string {
  const url = decodeEntities(raw);
  if (!url.startsWith("https://www.bing.com/ck/a?")) return url;
  const m = url.match(/[&?]u=a1([^&]+)/);
  if (!m) return url;
  const decoded = Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return /^https?:\/\//.test(decoded) ? decoded : url;
}

async function fetchHtml(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
    },
    redirect: "follow",
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`搜索上游 HTTP ${res.status}`);
  return (await res.text()).slice(0, MAX_HTML_BYTES);
}

/** 跟随百度跳转链接（/link?url=…）解析真实目标地址；失败保留原链接。 */
async function resolveBaiduLink(link: string, signal?: AbortSignal): Promise<string> {
  if (!/baidu\.com\/link\?url=/.test(link)) return link;
  try {
    const res = await fetch(link, {
      method: "HEAD",
      redirect: "follow",
      headers: { "user-agent": UA },
      signal: signal ?? AbortSignal.timeout(6_000),
    });
    if (/^https?:\/\//.test(res.url) && !/baidu\.com\/link\?/.test(res.url)) return res.url;
  } catch {
    /* keep the baidu link */
  }
  return link;
}

/** DeepSeek 官方搜索引擎（keyed）：自研搜索服务，结构化结果 + 相关度/权威度分层，Agent/RAG 场景专用。
 *  按成功请求计费（¥5/1000 次，空结果不计费）；snippet/summary 双轨摘要，正文走 fetch_webpage。 */
async function deepseekSearch(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchHit[]> {
  const api = createDeepSeekApiFromConfig();
  const results = await api.search({ query, count: limit, needContent: false, signal });
  if (results.length === 0) throw new Error("deepseek 0 results");
  return results.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet || r.summary.slice(0, 300),
    publishedAt: r.date ? r.date.slice(0, 10) : undefined,
    authority: r.authority >= 0 ? r.authority : undefined,
  }));
}

export interface SearchEngine {
  name: string;
  run: () => Promise<WebSearchHit[]>;
}

/** 引擎链按可用性有序组装：deepseek → tavily → searxng → baidu → bing；前面的成功即止。 */
export function buildSearchEngines(query: string, limit: number, signal?: AbortSignal): SearchEngine[] {
  const engines: SearchEngine[] = [];
  if (config.web.deepseekApiKey) engines.push({ name: "deepseek", run: () => deepseekSearch(query, limit, signal) });
  if (config.web.searchTavilyApiKey) engines.push({ name: "tavily", run: () => tavilySearch(query, limit, signal) });
  if (config.web.searchSearxngUrl) engines.push({ name: "searxng", run: () => searxngSearch(query, limit, signal) });
  engines.push({ name: "baidu", run: () => baiduSearch(query, limit, signal) });
  engines.push({ name: "bing", run: () => bingSearch(query, limit, signal) });
  return engines;
}

/** Tavily 引擎（keyed，最稳）：免费 1000 次/月，注册 https://tavily.com 取 key。 */
async function tavilySearch(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchHit[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: config.web.searchTavilyApiKey, query, max_results: limit, search_depth: "basic" }),
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`tavily HTTP ${res.status}`);
  const json = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  const hits = (json.results ?? [])
    .filter((r) => r.title && r.url)
    .map((r) => ({ title: r.title!, url: r.url!, snippet: (r.content ?? "").slice(0, 300) }));
  if (hits.length === 0) throw new Error("tavily 0 results");
  return hits;
}

/** SearXNG 引擎（自托管元搜索）：GET /search?format=json。 */
async function searxngSearch(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchHit[]> {
  const base = config.web.searchSearxngUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json&language=zh-CN`, {
    headers: { "user-agent": UA },
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`searxng HTTP ${res.status}`);
  const json = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  const hits = (json.results ?? [])
    .filter((r) => r.title && r.url)
    .slice(0, limit)
    .map((r) => ({ title: r.title!, url: r.url!, snippet: (r.content ?? "").slice(0, 300) }));
  if (hits.length === 0) throw new Error("searxng 0 results");
  return hits;
}

/** Baidu 引擎（爬虫兜底）：结果块 = result c-container；无 h3 的广告位跳过。 */
async function baiduSearch(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchHit[]> {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${Math.min(20, limit + 5)}&ie=utf-8`;
  const html = await fetchHtml(url, signal);
  if (/安全验证|wappass\.htm/.test(html)) throw new Error("baidu verify wall");
  const blocks = html.split(/<div class="result[^"]*c-container/).slice(1);
  const hits: WebSearchHit[] = [];
  for (const block of blocks) {
    const tM = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    if (!tM) continue;
    const title = stripTags(tM[1]);
    if (!title) continue;
    const aM = tM[1].match(/href="([^"]+)"/);
    hits.push({
      title,
      url: aM ? decodeEntities(aM[1]) : "",
      snippet: stripTags(block.replace(/<h3[\s\S]*?<\/h3>/, " ")).slice(0, 260),
    });
    if (hits.length >= limit) break;
  }
  if (hits.length === 0) throw new Error("baidu 0 results");
  return Promise.all(hits.map(async (h) => (h.url ? { ...h, url: await resolveBaiduLink(h.url, signal) } : h)));
}

/** Bing 引擎（兜底）：结果块 = li.b_algo；/ck/a 跳转链接解码。 */
async function bingSearch(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchHit[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(30, limit + 5)}&setlang=zh-hans&ensearch=0`;
  const html = await fetchHtml(url, signal);
  const hits: WebSearchHit[] = [];
  for (const block of html.split(`<li class="b_algo"`).slice(1)) {
    const linkM = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkM) continue;
    const title = stripTags(linkM[2]);
    if (!title) continue;
    const snipM = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    hits.push({
      title,
      url: unwrapBingRedirect(linkM[1]),
      snippet: snipM ? stripTags(snipM[1]).slice(0, 300) : "",
    });
    if (hits.length >= limit) break;
  }
  if (hits.length === 0) throw new Error("bing 0 results");
  return hits;
}

export function createWebSearchTool() {
  return defineTool({
    name: "web_search",
    description:
      "联网搜索公开网页（配置 DeepSeek key 时首选官方结构化搜索，带相关度/权威分层与发布时间；否则百度为主、Bing 兜底）。" +
      "返回与查询相关的标题、链接与摘要列表，用于收集外部/最新资料；" +
      "得到线索后可用 fetch_webpage 抓取具体页面正文。适合查考试大纲、行业标准、技术文档等公开信息。",
    inputSchema: z.object({
      query: z.string().min(1).max(200).describe("搜索关键词（可用空格组合多个词）"),
      limit: z.number().int().min(1).max(10).optional().describe("返回结果条数，默认 6"),
    }),
    async execute(args, _ctx, signal) {
      const limit = args.limit ?? 6;
      let hits: WebSearchHit[] = [];
      let engine = "(none)";
      const engines = buildSearchEngines(args.query, limit, signal);
      for (const candidate of engines) {
        try {
          hits = await candidate.run();
          engine = candidate.name; // 修复：循环变量曾遮蔽外层标签，输出恒为 (none)
          break;
        } catch (err) {
          log.warn(`[WEB_SEARCH] ${candidate.name} failed → next engine: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (hits.length === 0) {
        return "未搜索到相关结果。可尝试更换或精简关键词后重试。";
      }
      const lines = [`共 ${hits.length} 条结果（${engine}）：`, ""];
      hits.forEach((h, i) => {
        lines.push(`[${i + 1}] ${h.title}`);
        lines.push(`    ${h.url}`);
        if (h.snippet) lines.push(`    ${h.snippet}`);
        const meta = [
          h.publishedAt ? `发布: ${h.publishedAt}` : "",
          h.authority !== undefined ? `权威: ${h.authority}/4` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        if (meta) lines.push(`    （${meta}）`);
      });
      lines.push("", "需要页面正文时，用 fetch_webpage 抓取对应 URL。");
      return lines.join("\n");
    },
  });
}
