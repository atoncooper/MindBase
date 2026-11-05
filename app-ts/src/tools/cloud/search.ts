import { z } from "zod";
import { defineTool, type ToolOutput } from "../base.js";
import { createLogger } from "../../logger.js";
import type {
  CloudSemanticHit,
  CloudSemanticSearchResponse,
  CloudSimilarResponse,
} from "../../auth/app-cloud-client.js";
import type { Source } from "../../context/types.js";

/**
 * Cloud-drive retrieval tools for the main agent:
 *  - cloud_semantic_search: meaning-based file search across the user's drive
 *    (optionally inside one folder subtree);
 *  - cloud_similar_files: files whose content is close to one known file.
 *
 * Identity comes from the tool context only (ctx.uid). app-cloud stays the
 * authority: these tools only read its existing search endpoints and never
 * touch embeddings or Milvus directly. A degraded search service is reported
 * as readable text so the turn continues with other tools.
 */

const log = createLogger("CLOUD");

/** Transport surface the tools need; lets tests substitute a fake without the network. */
export interface CloudSearchClient {
  readonly configured: boolean;
  searchSemantic(
    uid: string,
    query: string,
    opts?: { folderId?: number; limit?: number },
  ): Promise<CloudSemanticSearchResponse>;
  getSimilar(uid: string, uploadUuid: string, limit?: number): Promise<CloudSimilarResponse>;
}

function displayName(hit: CloudSemanticHit): string {
  return hit.title || hit.original_name || "（无标题）";
}

function sourceOf(hit: CloudSemanticHit): Source {
  const title = hit.title || hit.original_name;
  return {
    uploadUuid: hit.upload_uuid,
    ...(title !== "" ? { title } : {}),
  };
}

/** Cut by code points so surrogate pairs (emoji) never split. */
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/** One hit per block: display name, score, uploadUuid and at most a few snippets. */
function renderHit(hit: CloudSemanticHit, index: number, maxSnippets: number, snippetChars: number): string {
  const lines = [
    `${index + 1}. ${displayName(hit)}（score=${hit.score.toFixed(4)}）`,
    `   uploadUuid：${hit.upload_uuid}`,
  ];
  const snippets = hit.snippets
    .slice(0, maxSnippets)
    .map((snippet) => snippet.trim())
    .filter((snippet) => snippet !== "")
    .map((snippet) => `   - ${truncate(snippet, snippetChars)}`);
  if (snippets.length > 0) lines.push("   相关片段：", ...snippets);
  return lines.join("\n");
}

function renderHits(hits: CloudSemanticHit[], maxSnippets: number, snippetChars: number): string {
  return hits.map((hit, i) => renderHit(hit, i, maxSnippets, snippetChars)).join("\n\n");
}

export function createCloudSemanticSearchTool(client: CloudSearchClient) {
  return defineTool({
    name: "cloud_semantic_search",
    description:
      "在用户云盘内按语义精确检索文件：输入自然语言问题/关键词，返回文件级结果（文件名、相关度、匹配片段、uploadUuid）。" +
      "用户问“云盘里哪份文档讲过 X”“找一下关于 X 的文件”时使用；" +
      "通用知识库问答（视频/云盘混合）仍用 vector_search。",
    inputSchema: z.object({
      query: z.string().min(1).max(500).describe("自然语言检索问题或关键词（1-500 字符）"),
      folderId: z.number().int().positive().optional().describe("限定文件夹 ID（含其子文件夹）；省略 = 全云盘"),
      limit: z.number().int().min(1).max(20).optional().describe("返回文件数，默认 10，最多 20"),
    }),
    async execute(args, ctx): Promise<ToolOutput> {
      if (!client.configured) {
        log.warn("[CLOUD] cloud_semantic_search called while app-cloud is not configured");
        return { content: "云盘服务未配置，暂时无法进行云盘语义检索。请稍后重试或联系管理员。" };
      }
      if (ctx.uid === undefined) {
        return { content: "检索失败：当前会话没有用户身份，无法访问云盘文件。" };
      }
      let resp: CloudSemanticSearchResponse;
      try {
        resp = await client.searchSemantic(ctx.uid, args.query, {
          ...(args.folderId !== undefined ? { folderId: args.folderId } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`[CLOUD] semantic search failed: ${message}`);
        return {
          content: `云盘语义检索服务暂不可用：${message}。请稍后重试，或改用 vector_search 检索知识库。`,
        };
      }
      if (resp.results.length === 0) {
        return {
          content: `云盘中没有找到与「${args.query}」语义相关的文件。可以换个说法，或改用 vector_search 检索知识库。`,
          sources: [],
        };
      }
      const totalNote = resp.total > resp.results.length ? `（共 ${resp.total} 个，展示前 ${resp.results.length} 个）` : "";
      return {
        content: `【云盘语义检索】「${args.query}」命中 ${resp.results.length} 个文件${totalNote}\n\n${renderHits(resp.results, 3, 200)}`,
        sources: resp.results.map(sourceOf),
      };
    },
  });
}

export function createCloudSimilarFilesTool(client: CloudSearchClient) {
  return defineTool({
    name: "cloud_similar_files",
    description:
      "查找与某个云盘文件内容相近的其他文件（相似文件列表，含文件名、相关度、匹配片段、uploadUuid）。" +
      "已知文件 uploadUuid、用户想找同主题的其他资料时使用；服务端已排除文件自身。",
    inputSchema: z.object({
      uploadUuid: z.string().min(16).max(128).describe("云盘文件 UUID（16-128 字符）"),
      limit: z.number().int().min(1).max(10).optional().describe("返回文件数，默认 5，最多 10"),
    }),
    async execute(args, ctx): Promise<ToolOutput> {
      if (!client.configured) {
        log.warn("[CLOUD] cloud_similar_files called while app-cloud is not configured");
        return { content: "云盘服务未配置，暂时无法查找相似文件。请稍后重试或联系管理员。" };
      }
      if (ctx.uid === undefined) {
        return { content: "查找失败：当前会话没有用户身份，无法访问云盘文件。" };
      }
      let resp: CloudSimilarResponse;
      try {
        resp = await client.getSimilar(ctx.uid, args.uploadUuid, args.limit);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`[CLOUD] similar files failed upload_uuid=${args.uploadUuid}: ${message}`);
        return { content: `云盘相似文件服务暂不可用：${message}。请稍后重试。` };
      }
      if (resp.items.length === 0) {
        return {
          content: "没有找到与该云盘文件内容相近的其他文件。",
          sources: [],
        };
      }
      return {
        content: `【相似云盘文件】找到 ${resp.items.length} 个内容相近的文件\n\n${renderHits(resp.items, 3, 200)}`,
        sources: resp.items.map(sourceOf),
      };
    },
  });
}
