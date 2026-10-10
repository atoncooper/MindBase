import { z } from "zod";
import { defineTool, type ToolOutput } from "../base.js";
import type { KgRetriever } from "../../kg/retriever.js";

/**
 * kg_search: knowledge-graph retrieval tool for the main agent, the app-ts
 * port of Python's tools/chat/kg_search.py. Scope travels implicitly through
 * the ToolRunContext (never an LLM-visible parameter); degraded dependencies
 * answer with text (not exceptions) so the ReAct loop keeps reasoning.
 */
export function createKgSearchTool(retriever: KgRetriever) {
  return defineTool({
    name: "kg_search",
    description:
      "在知识图谱（知识点/实体关系）中检索：实体之间的关系、跨视频的知识关联、" +
      "“X 和 Y 有什么关系/对比”类问题优先用它。返回实体卡片（描述/关系/原文出处）及来源。",
    inputSchema: z.object({
      query: z.string().min(1).describe("检索查询语句，用自然语言概括要找的实体或关系"),
      k: z.number().int().min(1).max(20).optional().describe("返回实体卡片数，默认 8"),
    }),
    async execute(args, ctx): Promise<ToolOutput> {
      if (!retriever.isAvailable()) {
        return { content: "知识图谱检索暂时不可用。", sources: [] };
      }
      const result = await retriever.retrieve(args.query, ctx.scope.bvids, args.k ?? 8);
      if (!result.sources.length && !result.content) {
        return {
          content: "知识图谱中没有找到相关实体，可以尝试 vector_search 或换个表述。",
          sources: [],
        };
      }
      return { content: result.content, sources: result.sources };
    },
  });
}
