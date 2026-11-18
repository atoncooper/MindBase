import { z } from "zod";
import { defineTool } from "../base.js";
import type { CodeOutputPort } from "./code-execution.js";
import type { ResearchExecutionGuard } from "./execution-guard.js";

const DEFAULT_LIMIT = 32 * 1024;

/** sandbox_execution_output: paged full stdout/stderr of a finished execution. */
export function createSandboxExecutionOutputTool(execution: CodeOutputPort, guard?: ResearchExecutionGuard) {
  return defineTool({
    name: "sandbox_execution_output",
    description:
      "读取一次已结束执行（run_code / sandbox_bash 返回的 execution_id）的完整 stdout 或 stderr。" +
      "返回 has_more / next_offset：如果 has_more=true，继续用 offset=next_offset 读取直到末尾。" +
      "当 run_code 提示 stdout_truncated 时，用本工具读取被截断的完整输出。",
    inputSchema: z.object({
      execution_id: z.string().min(1).max(64).describe("run_code/sandbox_bash 返回的 execution_id"),
      stream: z.enum(["stdout", "stderr"]).optional().describe("默认 stdout"),
      offset: z.number().int().nonnegative().optional().describe("字节偏移，续读时传 next_offset"),
      limit: z.number().int().positive().max(128 * 1024).optional().describe("单次最多字节数，默认 32768"),
    }),
    defaultTimeoutMs: 60_000,
    async execute(args, ctx, signal) {
      if (guard) {
        const blocked = await guard(ctx);
        if (blocked) return blocked;
      }
      try {
        const result = await execution.readOutput(
          {
            executionId: args.execution_id,
            stream: args.stream ?? "stdout",
            offset: args.offset ?? 0,
            limit: args.limit ?? DEFAULT_LIMIT,
            ...(ctx.uid !== undefined ? { uid: ctx.uid } : {}),
          },
          signal,
        );
        const lines = [
          "execution_id: " + result.executionId,
          "stream: " + result.stream,
          "offset: " + result.offset,
          "bytes: " + result.bytes,
          "total_bytes: " + result.totalBytes,
          "source_bytes: " + result.sourceBytes,
          "truncated: " + (result.truncated ? "true" : "false"),
          "has_more: " + (result.hasMore ? "true" : "false"),
          "next_offset: " + result.nextOffset,
        ];
        if (result.truncated) {
          lines.push("提示：capture 上限已截断，source_bytes 是程序实际输出大小，但超过部分不可再取。");
        }
        if (result.hasMore) {
          lines.push("提示：还有未读内容，继续调用 sandbox_execution_output，offset=" + result.nextOffset + "。");
        }
        lines.push("content:");
        lines.push(result.content);
        return lines.join("\n");
      } catch (error) {
        return "读取执行输出失败：" + (error instanceof Error ? error.message : String(error));
      }
    },
  });
}
