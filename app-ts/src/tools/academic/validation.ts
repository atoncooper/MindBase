import { z } from "zod";
import { defineTool } from "../base.js";
import type { ToolRunContext } from "../../context/types.js";
import type { ResearchValidationService } from "../../services/research/research-validation.js";

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
        const lines = [
          "校验结果：" + (report.pass ? "通过" : "未通过"),
          "引用总数：" + report.citations.total,
          "缺失引用：" + (report.citations.missing.join(", ") || "无"),
          "未核验引用：" + (report.citations.unverified.join(", ") || "无"),
          "成功 run：" + report.runs.total + "，缺少脚本 hash：" + (report.runs.unreproducible.join(", ") || "无"),
          "无效证据引用（[[run:id]] 不存在或未成功）：" + (report.runs.invalidRefs.join(", ") || "无"),
          "结果章节：" + (report.results.sections.join(", ") || "无"),
          "结果章节缺少 [[run:id]] 证据引用：" + (report.results.withoutEvidenceRef.join(", ") || "无"),
        ];
        if (report.numbers.unmatched.length > 0) {
          lines.push(
            "数字-证据提示（不阻断）：" +
              report.numbers.unmatched
                .slice(0, 8)
                .map((item) => item.section + "=" + item.value)
                .join("、") +
              (report.numbers.unmatched.length > 8 ? " 等 " + report.numbers.unmatched.length + " 个" : ""),
          );
        }
        if (report.tables.withoutEvidence.length > 0) {
          lines.push("表格缺证据提示（不阻断）：" + report.tables.withoutEvidence.join("、"));
        }
        // Advisory (does not affect pass): numeric sections without run evidence.
        if (report.sectionsMissingRunRef.length > 0) {
          lines.push(
            "数字提示（不阻断，建议补充证据）：" +
              report.sectionsMissingRunRef.join("、") +
              (report.sectionsWithNumbers.length > report.sectionsMissingRunRef.length
                ? "（共 " + report.sectionsWithNumbers.length + " 个含数字章节）"
                : ""),
          );
        }
        return lines.join("\n");
      } catch (err) {
        return "校验失败：" + (err instanceof Error ? err.message : String(err));
      }
    },
  });
}
