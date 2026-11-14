import { z } from "zod";
import { defineTool, type ToolOutput } from "../base.js";
import { createLogger } from "../../logger.js";
import type { CloudDocumentSummary, CloudSummaryResponse } from "../../clients/app-cloud-client.js";
import type { Source } from "../../context/types.js";

/**
 * cloud_doc_summary: reads the AI summary app-cloud generated for one cloud-drive
 * document. Identity comes from the tool context only (ctx.uid) — the model can
 * never ask for another user's document. A missing summary is a normal state
 * (the file was ingested before summarization ran), so it is reported as text
 * rather than raised as an error.
 */

const log = createLogger("CLOUD");

/** Transport surface the tool needs; lets tests substitute a fake without the network. */
export interface CloudDocSummaryClient {
  readonly configured: boolean;
  getSummary(uid: string, uploadUuid: string): Promise<CloudSummaryResponse>;
}

function bulletList(items: string[], empty = "（无）"): string {
  if (items.length === 0) return empty;
  return items.map((item, i) => `${i + 1}. ${item}`).join("\n");
}

function inlineList(items: string[], empty = "（无）"): string {
  return items.length === 0 ? empty : items.join("、");
}

/** Render one summary as the structured text handed back to the model. */
export function formatCloudSummary(summary: CloudDocumentSummary, opts: { title?: string; stale?: boolean } = {}): string {
  const header = opts.title ? `【云盘文档摘要】${opts.title}` : "【云盘文档摘要】";
  const parts: string[] = [header];
  if (opts.stale) {
    parts.push("注意：文件内容已更新，当前摘要基于较早版本（如需刷新，请重新上传该文件或联系管理员）。");
  }
  parts.push(
    `概览：\n${summary.overview || "（无）"}`,
    `主题：${inlineList(summary.topics)}`,
    `实体：${inlineList(summary.entities)}`,
    `关键点：\n${bulletList(summary.key_points)}`,
    `待办：\n${bulletList(summary.todos)}`,
    `可回答问题：\n${bulletList(summary.answers_questions)}`,
  );
  return parts.join("\n\n");
}

export { createCloudSemanticSearchTool, createCloudSimilarFilesTool } from "./search.js";
export type { CloudSearchClient } from "./search.js";

export function createCloudDocSummaryTool(client: CloudDocSummaryClient) {
  return defineTool({
    name: "cloud_doc_summary",
    description:
      "读取某个云盘文档已生成的 AI 摘要（概览/主题/实体/关键点/待办/可回答问题）。" +
      "当用户询问云盘文档的内容、要点或待办，且已知文件 uploadUuid 时使用；" +
      "摘要尚未生成时会返回提示，可告知用户稍后刷新或重新上传该文件。",
    inputSchema: z.object({
      uploadUuid: z.string().min(16).max(128).describe("云盘文件 UUID（16-128 字符），来自云盘文件列表/引用"),
    }),
    async execute(args, ctx): Promise<ToolOutput> {
      if (!client.configured) {
        log.warn("[CLOUD] cloud_doc_summary called while app-cloud is not configured");
        return { content: "云盘摘要服务未配置，暂时无法读取云盘文档摘要。请稍后重试或联系管理员。" };
      }
      if (ctx.uid === undefined) {
        return { content: "读取失败：当前会话没有用户身份，无法访问云盘文档。" };
      }
      let resp: CloudSummaryResponse;
      try {
        resp = await client.getSummary(ctx.uid, args.uploadUuid);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`[CLOUD] summary read failed upload_uuid=${args.uploadUuid}: ${message}`);
        return { content: `云盘摘要服务暂不可用：${message}。请稍后重试，或告知用户该功能暂不可用。` };
      }
      const title = resp.title ?? resp.original_name;
      const source: Source = {
        uploadUuid: resp.upload_uuid || args.uploadUuid,
        ...(title !== undefined ? { title } : {}),
      };
      if (!resp.available || resp.summary === null) {
        return {
          content: "该云盘文档的摘要尚未生成（可稍后刷新；如需重新生成，请重新上传该文件或联系管理员）。",
          sources: [source],
        };
      }
      return {
        content: formatCloudSummary(resp.summary, {
          ...(title !== undefined ? { title } : {}),
          stale: resp.stale,
        }),
        sources: [source],
      };
    },
  });
}
