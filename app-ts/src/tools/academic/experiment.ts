import { z } from "zod";
import { defineTool } from "../base.js";
import type { ToolRunContext } from "../../context/types.js";
import type { ResearchExperimentRunner } from "../../services/research-experiment.js";
import type { AcademicProjectRepository } from "../../repository/academic.js";
import type { ResearchApprovalService } from "../../services/research-approval.js";

/**
 * academic_experiment: submit a CS/SE/AI experiment (code/training/analysis) to
 * the persistent background runner. Returns immediately; completion calls the
 * AI back asynchronously instead of making the model poll the sandbox.
 */
export function createAcademicExperimentTool(
  runner: ResearchExperimentRunner,
  projects: AcademicProjectRepository,
  approvals?: ResearchApprovalService,
) {
  return defineTool({
    name: "academic_experiment",
    description:
      "提交后台科研实验（仅代码/训练/数据分析类）。action=submit 立即返回 experiment_id，实验在沙箱后台执行；" +
      "完成/中断后系统会回调 AI。action=get/list 查询状态，action=cancel 取消。项目必须已有 project_id。",
    inputSchema: z.object({
      action: z.enum(["submit", "get", "list", "cancel"]),
      projectId: z.string().optional(),
      experimentId: z.string().optional(),
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
        if (approvals && !(await approvals.isApproved(uid, args.projectId, "experiment"))) {
          const pending = await approvals.list(uid, args.projectId);
          const existing = pending.find((a) => a.kind === "experiment" && a.status === "pending");
          return (
            "实验需要人工审批才能启动。请先调用 research_approval(action=request, kind=experiment) 创建审批；" +
            "用户批准后再提交。" +
            (existing ? "\n当前待审批 approval_id=" + existing.id : "")
          );
        }
        if (!args.code || !args.code.trim()) return "submit 需要 code。";
        const exp = await runner.submit({
          uid,
          projectId: args.projectId,
          ...(ctx.chatSessionId ? { chatSessionId: ctx.chatSessionId } : {}),
          ...(args.title ? { title: args.title } : {}),
          language: args.language ?? "python",
          code: args.code,
          timeoutMs: args.timeoutMs ?? 30 * 60 * 1000,
        });
        return (
          "实验已提交，后台执行中（不要轮询）。\nexperiment_id=" +
          exp.id +
          "\nstatus=" +
          exp.status +
          "\n完成或中断后会回调 AI。"
        );
      } catch (err) {
        return "实验操作失败：" + (err instanceof Error ? err.message : String(err));
      }
    },
  });
}
