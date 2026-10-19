import { z } from "zod";
import { defineTool } from "../base.js";
import type { WebFetchPort } from "./fetcher.js";

/**
 * fetch_webpage: crawl a single public web page → title + cleaned body text + follow-up links.
 * Cleaning (nav/ads/hidden-element removal, main-content preference, structural text)
 * lives in the fetcher (html-cleaner.ts); all budgets (timeout/size/redirect hops/
 * per-host politeness) are enforced by the TimeoutManager and the port; the tool only
 * formats the result for the LLM.
 * When configured, the DeepSeek official Fetch API is the primary provider (cloud-side
 * rendering, Markdown result); the local fetcher only runs when DeepSeek is unavailable
 * or fails — see deepseek.ts.
 */
export function createFetchWebpageTool(port: WebFetchPort) {
  return defineTool({
    name: "fetch_webpage",
    description:
      "抓取一个公开网页并提取正文。默认走 DeepSeek 官方抓取（云端渲染，返回标题+Markdown 正文，无页面内链接）；" +
      "官方不可用或失败时自动回退本地抓取（去噪后正文 + 页面内链接）。" +
      "用户给出具体 URL、或问题涉及网页当前内容时调用。仅支持 http/https 公开地址；内网地址会被拒绝。" +
      "需要更多页面时先搜索获取线索，再逐个抓取。",
    inputSchema: z.object({
      url: z.string().url().describe("要抓取的完整 URL（http/https）"),
      maxChars: z
        .number()
        .int()
        .min(500)
        .max(20_000)
        .optional()
        .describe("返回正文的最多字符数，默认 6000"),
    }),
    async execute(args, _ctx, signal) {
      const maxChars = args.maxChars ?? 6000;
      const page = await port.fetch(args.url, { signal });
      const text =
        page.text.length > maxChars
          ? `${page.text.slice(0, maxChars)}\n…[正文过长已截断：共 ${page.text.length} 字符]`
          : page.text;
      const lines = [`标题: ${page.title || "(无)"}`, `URL: ${page.finalUrl}`];
      if (page.description) lines.push(`摘要: ${page.description}`);
      lines.push(``, text);
      if (page.links.length > 0) {
        lines.push(``, `页面内可跟进的链接（前 ${page.links.length} 个）:`);
        for (const link of page.links) lines.push(`- ${link}`);
      }
      return lines.join("\n");
    },
  });
}
