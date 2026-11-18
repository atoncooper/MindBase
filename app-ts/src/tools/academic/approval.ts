import { z } from "zod";
import { defineTool } from "../base.js";
import type { ToolRunContext } from "../../context/types.js";
import type { ResearchApprovalService } from "../../services/research/research-approval.js";
import type { ResearchApproval } from "../../repository/research-approvals.js";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** One-line v2 state: validity window, one-shot consumption and scope. */
function approvalStateText(approval: ResearchApproval, now: number): string {
  const scope = approval.scope ?? "legacy（项目级）";
  const validity =
    approval.expiresAt === undefined
      ? "不过期"
      : approval.expiresAt <= now
        ? "已过期（" + iso(approval.expiresAt) + "）"
        : "有效至 " + iso(approval.expiresAt);
  const consumption =
    approval.consumedAt === undefined ? "未消费" : "已消费（" + iso(approval.consumedAt) + "）";
  const experiment = approval.experimentId ? " · experiment=" + approval.experimentId : "";
  return "scope=" + scope + " · " + validity + " · " + consumption + experiment;
}

/**
 * research_approval: request a human decision. The AI cannot approve — only the
 * user-facing REST endpoint can, so experiment/submission gates stay meaningful.
 *
 * The tool keeps the legacy surface: `request` only creates a pending row (the
 * REST layer/user decides), while `status` now additionally reports the v2
 * validity window, one-shot consumption state and scope.
 */
export function createResearchApprovalTool(service: ResearchApprovalService) {
  return defineTool({
    name: "research_approval",
    description:
      "请求人工审批（科研实验/论文提交）。action=request 创建待审批记录并返回 approval_id（只能创建 pending，AI 不能自行批准）；" +
      "action=status 查看项目审批（含有效期、是否已消费、scope）。用户需在工作台确认；每次高风险动作消耗一条审批。",
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
          const now = Date.now();
          return rows
            .map(
              (a) =>
                "- " +
                a.kind +
                " · " +
                a.status +
                " · " +
                a.id +
                " · " +
                approvalStateText(a, now) +
                (a.note ? " · " + a.note : ""),
            )
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
          "\n" +
          approvalStateText(approval, Date.now()) +
          "\n等待用户在工作台批准后继续（审批一次性，过期或消费后需重新申请）。"
        );
      } catch (err) {
        return "审批操作失败：" + (err instanceof Error ? err.message : String(err));
      }
    },
  });
}
