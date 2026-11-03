import { z } from "zod";
import { defineTool } from "../base.js";
import type { CodeExecutionPort } from "./code-execution.js";

/**
 * run_code: executes code in the sandbox .
 *
 * The tool only orchestrates the injected CodeExecutionPort: identity (uid) comes
 * from ToolRunContext, the cancellation signal from the tool runtime, and the
 * port decides whether the backend is the remote app-sandbox control plane or the
 * honest Noop stub. Output is Chinese plain text for the ReAct loop: execution id
 * and artifact summaries are included so the agent can cite what actually ran.
 *
 * Failure policy: a port result with `sandboxAvailable=false` is rendered as
 * guidance telling the model the code was NOT executed — the tool never throws and
 * never fabricates a successful run.
 */
export function createRunCodeTool(exec: CodeExecutionPort) {
  return defineTool({
    name: "run_code",
    description:
      "在隔离沙箱中运行一段代码并返回 stdout/stderr，附带 execution_id 与产物列表（如有）。用于验证代码正确性。",
    inputSchema: z.object({
      language: z.enum(["javascript", "python"]).describe("语言"),
      code: z.string().min(1).max(20_000).describe("完整代码"),
      timeoutMs: z.number().int().positive().optional().describe("超时毫秒，默认 10000"),
    }),
    async execute(args, ctx, signal) {
      const res = await exec.run(
        {
          language: args.language,
          code: args.code,
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          ...(ctx.uid !== undefined ? { uid: ctx.uid } : {}),
        },
        signal,
      );

      if (!res.sandboxAvailable) {
        const reason = res.error?.trim() || res.stderr.trim() || "沙箱未配置";
        return `沙箱不可用：${reason}。\n无法运行代码，请直接给出代码与讲解，并注明未经实际运行验证。`;
      }

      const lines = [`exit: ${res.ok ? "ok" : "failed"}`];
      if (res.exitCode !== undefined) lines.push(`exit_code: ${res.exitCode}`);
      if (res.executionId) lines.push(`execution_id: ${res.executionId}`);
      if (res.artifacts && res.artifacts.length > 0) {
        lines.push(`artifacts (${res.artifacts.length}):`);
        for (const artifact of res.artifacts) {
          const size = artifact.sizeBytes !== undefined ? ` (${artifact.sizeBytes} bytes)` : "";
          const url = artifact.url ? ` ${artifact.url}` : "";
          lines.push(`- ${artifact.name}${size}${url}`);
        }
      }
      lines.push(res.stdout ? `stdout:\n${res.stdout.slice(0, 4000)}` : "stdout: (空)");
      if (res.stderr) lines.push(`stderr:\n${res.stderr.slice(0, 2000)}`);
      if (!res.ok && res.error) lines.push(`error: ${res.error}`);
      return lines.join("\n");
    },
  });
}
