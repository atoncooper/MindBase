import { z } from "zod";
import { defineTool } from "../base.js";
import type { ToolRunContext } from "../../context/types.js";
import type { ResearchAnalysisService } from "../../services/research-analysis.js";

/**
 * academic_analysis: turn the evidence ledger into a deterministic results
 * table, upload it to 04_结果 and (optionally) write it into the manuscript's
 * results section. Every row carries [[run:<id>]].
 */
export function createAcademicAnalysisTool(service: ResearchAnalysisService) {
  return defineTool({
    name: "academic_analysis",
    description:
      "根据实验 evidence 生成结果表（Markdown）。会写入 04_结果/results_summary.md；传 documentId 时同时覆盖论文章节的“结果”部分。" +
      "表格每行带 [[run:<id>]]，供 academic_validation 校验数字来源。",
    inputSchema: z.object({
      projectId: z.string(),
      documentId: z.string().optional(),
    }),
    async execute(args, ctx: ToolRunContext) {
      if (!ctx.uid) return "当前会话没有用户身份。";
      try {
        const result = await service.generateResultsTable(ctx.uid, args.projectId, args.documentId);
        return [
          "结果表已生成。",
          ...(result.uploadUuid ? ["upload_uuid=" + result.uploadUuid, "folder_id=" + String(result.folderId)] : ["云盘上传失败（表仍返回）"]),
          "",
          result.markdown.slice(0, 6000),
        ].join("\n");
      } catch (err) {
        return "结果表生成失败：" + (err instanceof Error ? err.message : String(err));
      }
    },
  });
}
