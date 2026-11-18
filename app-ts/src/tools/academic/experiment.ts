import { z } from "zod";
import { defineTool } from "../base.js";
import type { ToolRunContext } from "../../context/types.js";
import {
  ResearchExperimentDuplicateError,
  ResearchExperimentQueueFullError,
  type ResearchExperimentRunner,
} from "../../services/research/research-experiment.js";
import type { AcademicProjectRepository } from "../../repository/academic.js";
import type { QuotaService } from "../../services/quota.js";
import type { ResearchApproval } from "../../repository/research-approvals.js";
import { ResearchApprovalError, type ResearchApprovalService } from "../../services/research/research-approval.js";

/** Guidance returned when the human gate is missing / expired / already spent. */
async function approvalFailureText(
  approvals: ResearchApprovalService,
  uid: string,
  projectId: string,
  approvalId: string | undefined,
  err: ResearchApprovalError,
): Promise<string> {
  if (approvalId !== undefined) {
    return (
      "实验审批不可用：" +
      err.message +
      "\napproval_id=" +
      approvalId +
      "\n请让用户先在工作台审批中心批准，或重新调用 research_approval(action=request, kind=experiment) 申请。"
    );
  }
  let pendingId: string | undefined;
  try {
    pendingId = (await approvals.list(uid, projectId)).find(
      (a) => a.kind === "experiment" && a.status === "pending",
    )?.id;
  } catch {
  // Guidance only — a failed pending lookup must not hide the real reason.
  }
  return (
    "实验需要人工审批才能提交。\n原因：" +
    err.message +
    "\n请先调用 research_approval(action=request, kind=experiment) 创建审批；用户批准后再提交（每次实验消耗一条审批）。" +
    (pendingId ? "\n当前待审批 approval_id=" + pendingId : "")
  );
}

/**
 * academic_experiment: submit a CS/SE/AI experiment (code/training/analysis) to
 * the persistent background runner. Returns immediately; completion calls the
 * AI back asynchronously instead of making the model poll the sandbox.
 *
 * Submit is behind the human approval gate (one decision = one experiment): an
 * explicitly passed approvalId is spent through consumeById, otherwise the
 * newest usable project experiment approval is consumed. A successful submit
 * then binds the approval to the experiment id for auditability.
 */
export function createAcademicExperimentTool(
  runner: ResearchExperimentRunner,
  projects: AcademicProjectRepository,
  approvals?: ResearchApprovalService,
  quota?: Pick<QuotaService, "consumeKind">,
) {
  return defineTool({
    name: "academic_experiment",
    description:
      "提交后台科研实验（仅代码/训练/数据分析类）。submit 需要有效的人工审批（每次实验消耗一条）：可传 approvalId，" +
      "或先 research_approval(action=request, kind=experiment) 等用户批准后自动消费项目级审批；无有效审批会被拒绝。" +
      "action=submit 立即返回 experiment_id，实验在沙箱后台执行；完成/中断后系统会回调 AI。action=get/list 查询状态，action=cancel 取消。项目必须已有 project_id。",
    inputSchema: z.object({
      action: z.enum(["submit", "get", "list", "cancel"]),
      projectId: z.string().optional(),
      experimentId: z.string().optional(),
      approvalId: z
        .string()
        .optional()
        .describe("已批准的人工审批 id（一次一用）；不传则自动消费项目级已批准的 experiment 审批"),
      title: z.string().optional(),
      language: z.string().optional().describe("python / bash / node 等"),
      code: z.string().optional().describe("要执行的代码；submit 时必填"),
      timeoutMs: z.number().int().min(1000).max(24 * 60 * 60 * 1000).optional(),
    }),
    async execute(args, ctx: ToolRunContext) {
      const uid = ctx.uid;
      if (!uid) return "当前会话没有用户身份，无法提交实验。";
      try {
        if (args.action === "list") {
          if (!args.projectId) return "缺少 projectId。";
          const runs = await runner.list(uid, args.projectId, 20);
          if (runs.length === 0) return "该项目还没有实验记录。";
          return runs
            .map((r) => "- " + r.id + " · " + r.status + " · " + (r.title ?? r.language) + " · " + new Date(r.createdAt).toISOString())
            .join("\n");
        }
        if (args.action === "get") {
          if (!args.experimentId) return "缺少 experimentId。";
          const run = await runner.get(args.experimentId);
          if (!run || run.uid !== uid) return "实验不存在或无权访问。";
          return [
            "experiment_id=" + run.id,
            "status=" + run.status,
            "exit_code=" + String(run.exitCode ?? ""),
            "stdout_preview=" + (run.stdoutPreview ?? "").slice(0, 3000),
            "stderr_preview=" + (run.stderrPreview ?? "").slice(0, 2000),
            "error=" + (run.error ?? ""),
            ...(run.artifacts && run.artifacts.length > 0
              ? ["artifacts=" + run.artifacts.map((a) => a.name).join(", ")]
              : []),
          ].join("\n");
        }
        if (args.action === "cancel") {
          if (!args.experimentId) return "缺少 experimentId。";
          const ok = await runner.cancel(args.experimentId);
          return ok ? "已请求取消实验。" : "实验不在运行中，或不存在。";
        }
        if (!args.projectId) return "缺少 projectId：请先创建学术项目。";
        const project = await projects.get(uid, args.projectId);
        if (!project) return "项目不存在或无权访问。";
        if (!args.code || !args.code.trim()) return "submit 需要 code。";
        if (quota && !(await quota.consumeKind(uid, "academic_experiment"))) {
          return "今日实验提交次数已用完（科研配额），请明天再试或升级会员。";
        }
        // Admission first (queue cap / duplicate) so a rejected submit never
        // burns the user's one-shot experiment approval.
        try {
          await runner.preflight({
            uid,
            projectId: args.projectId,
            language: args.language ?? "python",
            code: args.code,
          });
        } catch (err) {
          if (err instanceof ResearchExperimentQueueFullError || err instanceof ResearchExperimentDuplicateError) {
            return err.message + (err instanceof ResearchExperimentDuplicateError ? "\n可用 action=get 查看该实验的进度。" : "");
          }
          throw err;
        }
        // Human gate: spend an approved decision before any sandbox work. The
        // approval is one-shot, so the row is consumed even though submit could
        // still fail afterwards (the user must re-request in that rare case).
        let approval: ResearchApproval | undefined;
        if (approvals) {
          try {
            if (args.approvalId !== undefined) {
              // An approval is project-scoped: spending another project's decision
              // would let a user-approved run authorise a different experiment.
              const belongs = (await approvals.list(uid, args.projectId)).some(
                (a) => a.id === args.approvalId,
              );
              if (!belongs) {
                return (
                  "实验审批不存在或不属于当前项目。\napproval_id=" +
                  args.approvalId +
                  "\n请确认审批所属项目，或在当前项目重新调用 research_approval(action=request, kind=experiment) 申请。"
                );
              }
              approval = await approvals.consumeById(uid, args.approvalId);
            } else {
              approval = await approvals.consume(uid, args.projectId, "experiment");
            }
          } catch (err) {
            if (!(err instanceof ResearchApprovalError)) throw err;
            return await approvalFailureText(approvals, uid, args.projectId, args.approvalId, err);
          }
        } else if (args.approvalId !== undefined) {
          return "审批服务未启用，无法校验 approvalId，已拒绝提交。";
        }
        const exp = await runner.submit({
          uid,
          projectId: args.projectId,
          ...(ctx.chatSessionId ? { chatSessionId: ctx.chatSessionId } : {}),
          ...(args.title ? { title: args.title } : {}),
          language: args.language ?? "python",
          code: args.code,
          timeoutMs: args.timeoutMs ?? 30 * 60 * 1000,
          ...(approval ? { approvalId: approval.id } : {}),
        });
        let bindingNote = "";
        if (approvals && approval && approval.experimentId === undefined) {
          try {
            await approvals.bindExperiment(uid, approval.id, exp.id);
          } catch {
            // The experiment is already queued; a failed audit bind must not
            // report the submit as failed.
            bindingNote = "\n警告：实验已提交，但审批绑定 experiment_id 失败，请联系管理员核查。";
          }
        }
        return (
          "实验已提交，后台执行中（不要轮询）。\nexperiment_id=" +
          exp.id +
          "\nstatus=" +
          exp.status +
          (approval ? "\napproval_id=" + approval.id + "（已消费，一次一用）" : "") +
          bindingNote +
          "\n完成或中断后会回调 AI。"
        );
      } catch (err) {
        return "实验操作失败：" + (err instanceof Error ? err.message : String(err));
      }
    },
  });
}
