import { z } from "zod";
import { defineTool } from "../base.js";
import type { CodeExecutionPort } from "./code-execution.js";

/** run_code: executes code in the sandbox. Returns honestly when the sandbox is not configured (stub semantics). */
export function createRunCodeTool(exec: CodeExecutionPort) {
  return defineTool({
    name: "run_code",
    description: "在隔离沙箱中运行一段代码并返回 stdout/stderr。用于验证代码正确性。",
    inputSchema: z.object({
      language: z.enum(["javascript", "python"]).describe("语言"),
      code: z.string().min(1).max(20_000).describe("完整代码"),
      timeoutMs: z.number().int().positive().optional().describe("超时毫秒，默认 10000"),
    }),
    async execute(args) {
      const res = await exec.run(args.language, args.code, args.timeoutMs);
      if (!res.sandboxAvailable) {
        return `沙箱未配置，无法运行代码。请直接给出代码与讲解，并注明未经实际运行验证。`;
      }
      const out = [
        `exit: ${res.ok ? "ok" : "failed"}`,
        res.stdout ? `stdout:\n${res.stdout.slice(0, 4000)}` : "stdout: (空)",
        res.stderr ? `stderr:\n${res.stderr.slice(0, 2000)}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      return out;
    },
  });
}
