import { z } from "zod";
import { defineTool } from "../base.js";
import type { CodeExecutionPort } from "./code-execution.js";

const MAX_OUTPUT = 12_000;
type ShellLanguage = "bash" | "sh" | "pwsh";

async function runShell(
  execution: CodeExecutionPort,
  shell: ShellLanguage,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  // Native app-sandbox command mode: the sandbox holds a lease per
  // (uid, project, purpose), so /workspace persists across calls until TTL.
  const result = await execution.run(
    {
      language: shell,
      code: command,
      timeoutMs,
    },
    signal,
  );
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return (output || result.error || "命令没有输出").slice(0, MAX_OUTPUT);
}

/** sandbox_bash: AI-authored bash command, executed inside app-sandbox. */
export function createSandboxBashTool(execution: CodeExecutionPort) {
  return defineTool({
    name: "sandbox_bash",
    description:
      "在 app-sandbox 隔离沙箱内执行 bash 命令（AI 自己填写 command）。同一 uid/project 的沙箱 lease 会复用 /workspace，" +
      "所以 grep/find/git/pytest 能看到之前生成的文件。不能访问宿主机。PowerShell 用 sandbox_pwsh。",
    inputSchema: z.object({
      command: z.string().min(1).max(20_000).describe("完整 bash 命令"),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
    }),
    defaultTimeoutMs: 180_000,
    async execute(args, _ctx, signal) {
      return runShell(execution, "bash", args.command, args.timeoutMs ?? 120_000, signal);
    },
  });
}

/** sandbox_pwsh: same sandbox, PowerShell 7 must exist in the image. */
export function createSandboxPwshTool(execution: CodeExecutionPort) {
  return defineTool({
    name: "sandbox_pwsh",
    description:
      "在 app-sandbox 隔离沙箱内执行 PowerShell 命令（AI 自己填写 command）。仅当沙箱镜像提供 pwsh 时可用；" +
      "不可用会明确返回，不会回落到宿主机 PowerShell。",
    inputSchema: z.object({
      command: z.string().min(1).max(20_000).describe("完整 PowerShell 命令"),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
    }),
    defaultTimeoutMs: 180_000,
    async execute(args, _ctx, signal) {
      return runShell(execution, "pwsh", args.command, args.timeoutMs ?? 120_000, signal);
    },
  });
}

/** sandbox_grep: structured grep/rg over the persistent sandbox workspace. */
export function createSandboxGrepTool(execution: CodeExecutionPort) {
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
    async execute(args, _ctx, signal) {
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
      return runShell(execution, "bash", command, args.timeoutMs ?? 30_000, signal);
    },
  });
}
