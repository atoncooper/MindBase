import { z } from "zod";
import { defineTool } from "../base.js";
import type { ToolRunContext } from "../../context/types.js";
import type { ResearchApprovalService } from "../../services/research-approval.js";

/**
 * research_approval: request a human decision. The AI cannot approve — only the
 * user-facing REST endpoint can, so experiment/submission gates stay meaningful.
 */
export function createResearchApprovalTool(service: ResearchApprovalService) {
  return defineTool({
    name: "research_approval",
    description:
      "请求人工审批（科研实验/论文提交）。action=request 创建待审批记录并返回 approval_id；" +
      "action=status 查看项目审批。AI 不能自行批准；用户需在工作台确认。",
    inputSchema: z.object({
      action: z.enum(["request", "status"]),
      projectId: z.string(),
      kind: z.enum(["experiment", "submission"]).optional(),
      note: z.string().optional(),
    }),
    async execute(args, ctx: ToolRunContext) {
      if (!ctx.uid) return "当前会话没有用户身份。";
      try {
        if (args.action === "status") {
          const rows = await service.list(ctx.uid, args.projectId);
          if (rows.length === 0) return "项目还没有审批记录。";
          return rows
            .map((a) => "- " + a.kind + " · " + a.status + " · " + a.id + (a.note ? " · " + a.note : ""))
            .join("\n");
        }
        if (!args.kind) return "request 需要 kind=experiment|submission。";
        const approval = await service.request(ctx.uid, args.projectId, args.kind, args.note);
        return (
          "已创建人工审批请求。\napproval_id=" +
          approval.id +
          "\nkind=" +
          approval.kind +
          "\nstatus=" +
          approval.status +
          "\n等待用户在工作台批准后继续。"
        );
      } catch (err) {
        return "审批操作失败：" + (err instanceof Error ? err.message : String(err));
      }
    },
  });
}
