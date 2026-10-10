import { z } from "zod";
import { config } from "../../config/index.js";
import { defineTool, type ToolOutput } from "../base.js";
import type { RAGService } from "../../rag/service.js";
import type { Source } from "../../context/types.js";

/**
 * vector_search: vector retrieval tool (core tool of the main agent).
 * The Python version does multi-query RRF fusion here (depends on query rewrite); v1 does a single query,
 * RRF fusion is left as an extension point (parallel multi-query merge inside execute once the rewrite port lands).
 */
export function createVectorSearchTool(rag: RAGService) {
  return defineTool({
    name: "vector_search",
    description:
      "在用户的知识库（B站视频/云盘文档）中做语义检索。当问题涉及视频内容、知识库细节、" +
      "或者需要事实依据时调用。返回相关片段及来源。",
    inputSchema: z.object({
      query: z.string().min(1).describe("检索查询语句，用自然语言概括要找的内容"),
      k: z.number().int().positive().optional().describe(`返回条数，默认 ${config.search.defaultK}`),
    }),
    async execute(args, ctx): Promise<ToolOutput> {
      const k = args.k ?? config.search.defaultK;
      const docs = await rag.search(args.query, k, {
        bvids: ctx.scope.bvids,
        uploadUuids: ctx.scope.uploadUuids,
        uid: ctx.uid,
      });
      if (docs.length === 0) {
        return {
          content: "知识库中没有找到相关内容。可以尝试换个表述，或用 list_videos 浏览已有视频列表。",
          sources: [],
        };
      }
      const sources: Source[] = docs.map((d) => ({
        bvid: d.metadata.bvid,
        uploadUuid: d.metadata.uploadUuid,
        title: d.metadata.title,
        pageTitle: d.metadata.pageTitle,
        url: d.metadata.url,
        chunkId: d.metadata.chunkId,
        score: d.score,
        rerankScore: d.rerankScore,
      }));
      const lines = docs.map((d, i) => {
        const head = [d.metadata.title, d.metadata.pageTitle, d.metadata.sectionTitle]
          .filter(Boolean)
          .join(" / ");
        const score = d.rerankScore ?? d.score;
        return `[${i + 1}] ${head || "(无标题)"}${score !== undefined ? ` (score=${score.toFixed(4)})` : ""}\n${d.text}`;
      });
      return {
        content: `检索到 ${docs.length} 条相关内容：\n\n${lines.join("\n\n")}`,
        sources,
      };
    },
  });
}
