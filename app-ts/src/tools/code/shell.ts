import { z } from "zod";
import { defineTool } from "../base.js";
import type { CodeExecutionPort } from "./code-execution.js";
import type { ResearchExecutionGuard } from "./execution-guard.js";

const MAX_OUTPUT = 12_000;
type ShellLanguage = "bash" | "sh" | "pwsh";

async function runShell(
  execution: CodeExecutionPort,
  shell: ShellLanguage,
  command: string,
  timeoutMs: number,
  ctx: { uid?: string; academicProjectId?: string },
  signal?: AbortSignal,
): Promise<string> {
  // Native app-sandbox command mode: the sandbox holds a lease per
  // (uid, project, purpose), so /workspace persists across calls until TTL.
  const result = await execution.run(
    {
      language: shell,
      code: command,
      timeoutMs,
      ...(ctx.uid !== undefined ? { uid: ctx.uid } : {}),
      ...(ctx.academicProjectId
        ? { projectId: ctx.academicProjectId, purpose: "chat" }
        : {}),
    },
    signal,
  );
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const notices: string[] = [];
  if (result.stdoutTruncated || result.stderrTruncated) {
    notices.push(
      "output_truncated: true (use sandbox_execution_output execution_id=" +
        (result.executionId ?? "?") +
        " with offset/next_offset to read the full stream)",
    );
  }
  const text = [output, ...notices].filter(Boolean).join("\n");
  return (text || result.error || "命令没有输出").slice(0, MAX_OUTPUT);
}

/** sandbox_bash: AI-authored bash command, executed inside app-sandbox. */
export function createSandboxBashTool(execution: CodeExecutionPort, guard?: ResearchExecutionGuard) {
  return defineTool({
    name: "sandbox_bash",
    description:
      "在 app-sandbox 隔离沙箱内执行 shell 命令。优先 bash；镜像没有 bash 时自动回退 POSIX sh。" +
      "当前部署的 sandbox-pwsh 镜像包含 bash 5.2，可用数组/[[ ]]/函数等 bash 语法；" +
      "同一 uid/project 的 lease 会复用 /workspace。不能访问宿主机。PowerShell 用 sandbox_pwsh。",
    inputSchema: z.object({
      command: z.string().min(1).max(20_000).describe("完整 bash 命令"),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
    }),
    defaultTimeoutMs: 180_000,
    async execute(args, ctx, signal) {
      if (guard) {
        const blocked = await guard(ctx);
        if (blocked) return blocked;
      }
      return runShell(execution, "bash", args.command, args.timeoutMs ?? 120_000, ctx, signal);
    },
  });
}

/** sandbox_pwsh: same sandbox, PowerShell 7 must exist in the image. */
export function createSandboxPwshTool(execution: CodeExecutionPort, guard?: ResearchExecutionGuard) {
  return defineTool({
    name: "sandbox_pwsh",
    description:
      "在 app-sandbox 隔离沙箱内执行 PowerShell 命令。当前部署的 sandbox-pwsh 镜像包含 PowerShell 7.4；" +
      "其他镜像没有 pwsh 时会明确返回不可用，不会回落到宿主机 PowerShell。",
    inputSchema: z.object({
      command: z.string().min(1).max(20_000).describe("完整 PowerShell 命令"),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
    }),
    defaultTimeoutMs: 180_000,
    async execute(args, ctx, signal) {
      if (guard) {
        const blocked = await guard(ctx);
        if (blocked) return blocked;
      }
      return runShell(execution, "pwsh", args.command, args.timeoutMs ?? 120_000, ctx, signal);
    },
  });
}

/** sandbox_grep: structured grep/rg over the persistent sandbox workspace. */
export function createSandboxGrepTool(execution: CodeExecutionPort, guard?: ResearchExecutionGuard) {
  return defineTool({
    name: "sandbox_grep",
    description:
      "在沙箱 /workspace 内按正则搜索文件内容。优先 rg，缺省回退 grep；返回 path:line: text。不要手写 grep 命令。",
    inputSchema: z.object({
      pattern: z.string().min(1).max(2000),
      path: z.string().optional().describe("搜索目录/文件，默认 /workspace"),
      glob: z.string().optional().describe("文件 glob，例如 *.ts"),
      maxResults: z.number().int().min(1).max(500).optional(),
      timeoutMs: z.number().int().positive().max(120_000).optional(),
    }),
    defaultTimeoutMs: 60_000,
    async execute(args, ctx, signal) {
      if (guard) {
        const blocked = await guard(ctx);
        if (blocked) return blocked;
      }
      const limit = args.maxResults ?? 200;
      const path = args.path ?? "/workspace";
      const quotedPattern = args.pattern.replace(/'/g, "'\\''");
      const quotedPath = path.replace(/'/g, "'\\''");
      const include = args.glob ? " --glob '" + args.glob.replace(/'/g, "'\\''") + "'" : "";
      const command =
        "(command -v rg >/dev/null 2>&1 && rg -n --no-heading -m " +
        limit +
        include +
        " '" + quotedPattern + "' '" + quotedPath + "') || grep -R -n --exclude-dir=.git -m " +
        limit +
        " '" + quotedPattern + "' '" + quotedPath + "' | head -n " + limit;
      return runShell(execution, "bash", command, args.timeoutMs ?? 30_000, ctx, signal);
    },
  });
}
