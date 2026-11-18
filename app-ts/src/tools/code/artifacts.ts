import { z } from "zod";
import { defineTool } from "../base.js";
import type { CodeArtifactPort } from "./code-execution.js";
import type { ResearchExecutionGuard } from "./execution-guard.js";

const DEFAULT_LIMIT = 32 * 1024;

/** sandbox_read_artifact: paged read of one stored artifact. */
export function createSandboxReadArtifactTool(execution: CodeArtifactPort, guard?: ResearchExecutionGuard) {
  return defineTool({
    name: "sandbox_read_artifact",
    description:
      "读取 run_code 产物（artifacts 列表里的 name）内容。文本按 utf8 返回，二进制按 base64 返回。" +
      "返回 has_more / next_offset；大文件用 offset=next_offset 继续读。",
    inputSchema: z.object({
      execution_id: z.string().min(1).max(64).describe("产物所属执行的 execution_id"),
      name: z.string().min(1).max(255).describe("artifacts 列表中的文件名"),
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
        const result = await execution.readArtifact(
          {
            executionId: args.execution_id,
            name: args.name,
            offset: args.offset ?? 0,
            limit: args.limit ?? DEFAULT_LIMIT,
            ...(ctx.uid !== undefined ? { uid: ctx.uid } : {}),
          },
          signal,
        );
        const lines = [
          "execution_id: " + result.executionId,
          "name: " + result.name,
          "content_type: " + (result.contentType || "unknown"),
          "encoding: " + result.encoding,
          "binary: " + (result.binary ? "true" : "false"),
          "offset: " + result.offset,
          "bytes: " + result.bytes,
          "total_bytes: " + result.totalBytes,
          "has_more: " + (result.hasMore ? "true" : "false"),
          "next_offset: " + result.nextOffset,
        ];
        if (result.hasMore) {
          lines.push("提示：还有未读内容，继续调用 sandbox_read_artifact，offset=" + result.nextOffset + "。");
        }
        lines.push("content:");
        lines.push(result.content);
        return lines.join("\n");
      } catch (error) {
        return "读取产物失败：" + (error instanceof Error ? error.message : String(error));
      }
    },
  });
}
