import { z } from "zod";
import { defineTool } from "../base.js";
import type { ToolRunContext } from "../../context/types.js";
import type { ResearchAnalysisService } from "../../services/research/research-analysis.js";

/** SSE artifact kind carrying the compare chart data to the UI. */
const ANALYSIS_ARTIFACT_KIND = "academic_analysis";

/**
 * academic_analysis: turn the evidence ledger into a deterministic results
 * table (action=summary) or compare the metrics of several runs
 * (action=compare). Summary rows carry [[run:<id>]] so academic_validation can
 * prove the manuscript numbers came from real executions; compare emits
 * chart-ready series.
 */
export function createAcademicAnalysisTool(service: ResearchAnalysisService) {
  return defineTool({
    name: "academic_analysis",
    description:
      "汇总实验 evidence。action=summary（默认）：生成结果表（Markdown，含指标列）并尽力写入 04_结果/results_summary.md，传 documentId 时同时覆盖论文章节的“结果”部分；" +
      "action=compare：对比多个 run 的指标，返回对比表与图表数据（chart.categories=run 名称，chart.series=指标系列，只比较所有 run 共有的指标；runIds 可选，缺省取最近 100 个 run）。" +
      "结果表每行带 [[run:<id>]]，供 academic_validation 校验数字来源。",
    inputSchema: z.object({
      action: z.enum(["summary", "compare"]).optional(),
      projectId: z.string(),
      documentId: z.string().optional(),
      runIds: z.array(z.string()).optional(),
    }),
    async execute(args, ctx: ToolRunContext) {
      if (!ctx.uid) return "当前会话没有用户身份。";
      if (args.action === "compare") {
        try {
          const result = await service.compareRuns(ctx.uid, args.projectId, args.runIds);
          ctx.collector.pushArtifacts([
            {
              kind: ANALYSIS_ARTIFACT_KIND,
              data: { action: "compare", chart: result.chart, runs: result.runs, metrics: result.metrics },
            },
          ]);
          return [
            "多 run 对比已生成：run " + result.runs + " 个，指标 " + result.metrics.length + " 个。",
            ...(result.uploadUuid
              ? ["upload_uuid=" + result.uploadUuid, "folder_id=" + String(result.folderId)]
              : ["云盘上传失败（对比数据仍返回）"]),
            "",
            result.markdown.slice(0, 6000),
          ].join("\n");
        } catch (err) {
          return "多 run 对比失败：" + (err instanceof Error ? err.message : String(err));
        }
      }
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
