import { z } from "zod";
import { defineTool } from "../base.js";
import type { ToolRunContext } from "../../context/types.js";
import type { ResearchValidationService } from "../../services/research-validation.js";

/**
 * academic_validation: citation / evidence / reproducibility gate for a
 * manuscript. The model must run this before export or submission.
 */
export function createAcademicValidationTool(service: ResearchValidationService) {
  return defineTool({
    name: "academic_validation",
    description:
      "校验论文引用、实验结果引用与可复现性。检查：引用是否存在且 verified、结果章节数字是否有 [[run:<id>]] 证据引用、成功 run 是否有脚本 hash。导出/提交前必须调用。",
    inputSchema: z.object({
      projectId: z.string(),
      documentId: z.string().optional(),
    }),
    async execute(args, ctx: ToolRunContext) {
      if (!ctx.uid) return "当前会话没有用户身份。";
      try {
        const report = await service.validate(ctx.uid, args.projectId, args.documentId);
        return [
          "校验结果：" + (report.pass ? "通过" : "未通过"),
          "引用总数：" + report.citations.total,
          "缺失引用：" + (report.citations.missing.join(", ") || "无"),
          "未核验引用：" + (report.citations.unverified.join(", ") || "无"),
          "成功 run：" + report.runs.total + "，缺少脚本 hash：" + (report.runs.unreproducible.join(", ") || "无"),
          "结果章节：" + (report.results.sections.join(", ") || "无"),
          "结果章节缺少 [[run:id]] 证据引用：" + (report.results.withoutEvidenceRef.join(", ") || "无"),
        ].join("\n");
      } catch (err) {
        return "校验失败：" + (err instanceof Error ? err.message : String(err));
      }
    },
  });
}
