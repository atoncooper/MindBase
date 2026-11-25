import { z } from "zod";
import { defineTool } from "../base.js";
import { createLogger } from "../../logger.js";
import type { CloudKgDocument } from "../../clients/app-cloud-client.js";

/**
 * cloud_file_read: read the PARSED SOURCE TEXT of one cloud-drive document.
 *
 * Unlike cloud_doc_summary (the pre-generated AI summary), this returns the
 * actual extracted text (pdf/docx/xlsx/pptx/markdown/html/text), so the agent
 * can condense the source itself instead of summarizing a summary. app-cloud
 * caps each document at 200k characters; offset/limit let the agent page
 * through long files without dumping everything into one context window.
 */
const log = createLogger("CLOUD");

export interface CloudFileReaderClient {
  readonly configured: boolean;
  getKgDocument(uid: string, uploadUuid: string): Promise<CloudKgDocument | undefined>;
}

export function createCloudFileReadTool(client: CloudFileReaderClient) {
  return defineTool({
    name: "cloud_file_read",
    description:
      "读取云盘文件的**已解析源正文**（不是 AI 摘要），用于“读源文件、精简、整理/不断完善笔记”。" +
      "需要 uploadUuid（可由 cloud_semantic_search 获得）。长文用 offset/limit 分页读取；" +
      "返回标题、总字数、本次区间和正文。文件未解析或不存在时会明确提示。",
    inputSchema: z.object({
      uploadUuid: z.string().min(16).max(128).describe("云盘文件 UUID"),
      offset: z.number().int().min(0).optional().describe("起始字符偏移，默认 0"),
      limit: z
        .number()
        .int()
        .min(2000)
        .max(60_000)
        .optional()
        .describe("本次返回的最大字符数，默认 30000，最多 60000"),
    }),
    async execute(args, ctx) {
      if (!client.configured) {
        log.warn("[CLOUD] cloud_file_read called while app-cloud is not configured");
        return "云盘服务未配置，暂时无法读取源文件。请稍后重试或联系管理员。";
      }
      if (ctx.uid === undefined) {
        return "读取失败：当前会话没有用户身份，无法访问云盘文件。";
      }
      let doc: CloudKgDocument | undefined;
      try {
        doc = await client.getKgDocument(ctx.uid, args.uploadUuid);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`[CLOUD] cloud_file_read failed upload_uuid=${args.uploadUuid}: ${message}`);
        return `云盘源文件读取失败：${message}。请稍后重试。`;
      }
      if (!doc || doc.text.trim() === "") {
        return "没有读到可用的源正文：文件不存在、尚未完成解析，或该类型不支持文本提取。可改用 cloud_doc_summary 查看摘要。";
      }
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 30_000;
      // Codepoint-safe slicing: never split a surrogate pair in CJK/emoji text.
      const chars = Array.from(doc.text);
      const total = doc.size_chars > 0 ? doc.size_chars : chars.length;
      const slice = chars.slice(offset, offset + limit).join("");
      const end = offset + Array.from(slice).length;
      const hasMore = end < chars.length;
      const serverTruncated = total > chars.length;
      const title = doc.title || args.uploadUuid;

      const header = [
        `【云盘源文件】${title}`,
        `总字数：${total}；本次返回：${offset}-${end}`,
        ...(serverTruncated
          ? [`（app-cloud 单次最多返回 ${chars.length} 字，超过部分需以原始文件为准）`]
          : []),
        ...(hasMore ? [`（还有后续内容：用 offset=${end} 继续读取）`] : []),
      ].join("\n");

      log.info(
        `[CLOUD] cloud_file_read upload_uuid=${args.uploadUuid} offset=${offset} chars=${end - offset}/${total}`,
      );
      return `${header}\n\n${slice}`;
    },
  });
}
