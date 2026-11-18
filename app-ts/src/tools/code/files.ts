import { z } from "zod";
import { defineTool } from "../base.js";
import type { CodeFilePort } from "./code-execution.js";
import type { ResearchExecutionGuard } from "./execution-guard.js";

/** Default page size for sandbox_read_file; server clamps to 128 KiB. */
const DEFAULT_READ_LIMIT = 32 * 1024;

function fileError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** sandbox_read_file: offset-addressed text file read with explicit has_more. */
export function createSandboxReadFileTool(execution: CodeFilePort, guard?: ResearchExecutionGuard) {
  return defineTool({
    name: "sandbox_read_file",
    description:
      "读取沙箱 /workspace 内的文本文件。大文件返回一页内容，并给出 has_more / next_offset；" +
      "如果 has_more=true，继续用 offset=next_offset 调用本工具，直到 has_more=false。" +
      "offset/bytes 都是 UTF-8 字节偏移，不是行号。",
    inputSchema: z.object({
      path: z.string().min(1).max(512).describe("绝对路径，必须在 /workspace 下"),
      offset: z.number().int().nonnegative().optional().describe("字节偏移，默认 0；续读时传上一次的 next_offset"),
      limit: z.number().int().positive().max(128 * 1024).optional().describe("单次最多读取字节数，默认 32768"),
    }),
    defaultTimeoutMs: 60_000,
    async execute(args, ctx, signal) {
      if (guard) {
        const blocked = await guard(ctx);
        if (blocked) return blocked;
      }
      try {
        const result = await execution.readFile(
          {
            path: args.path,
            offset: args.offset ?? 0,
            limit: args.limit ?? DEFAULT_READ_LIMIT,
            ...(ctx.uid !== undefined ? { uid: ctx.uid } : {}),
            ...(ctx.academicProjectId ? { projectId: ctx.academicProjectId } : {}),
            purpose: "chat",
          },
          signal,
        );
        const lines = [
          "path: " + result.path,
          "offset: " + result.offset,
          "bytes: " + result.bytes,
          "total_bytes: " + result.totalBytes,
          "has_more: " + (result.hasMore ? "true" : "false"),
          "next_offset: " + result.nextOffset,
        ];
        if (result.hasMore) {
          lines.push("提示：还有未读内容，继续调用 sandbox_read_file，offset=" + result.nextOffset + "。");
        }
        lines.push("content:");
        lines.push(result.content);
        return lines.join("\n");
      } catch (error) {
        return "读取文件失败：" + fileError(error);
      }
    },
  });
}

/** sandbox_write_file: replace one text file inside /workspace. */
export function createSandboxWriteFileTool(execution: CodeFilePort, guard?: ResearchExecutionGuard) {
  return defineTool({
    name: "sandbox_write_file",
    description:
      "向沙箱 /workspace 写入（覆盖）一个文本文件，自动创建父目录。适合写代码/配置/中间数据；" +
      "大文件请分多次写，单次内容不超过 1MB。",
    inputSchema: z.object({
      path: z.string().min(1).max(512).describe("绝对路径，必须在 /workspace 下"),
      content: z.string().max(1_000_000).describe("完整文件内容（覆盖写入）"),
    }),
    defaultTimeoutMs: 60_000,
    async execute(args, ctx, signal) {
      if (guard) {
        const blocked = await guard(ctx);
        if (blocked) return blocked;
      }
      try {
        const result = await execution.writeFile(
          {
            path: args.path,
            content: args.content,
            ...(ctx.uid !== undefined ? { uid: ctx.uid } : {}),
            ...(ctx.academicProjectId ? { projectId: ctx.academicProjectId } : {}),
            purpose: "chat",
          },
          signal,
        );
        return "已写入 " + result.bytes + " bytes → " + result.path;
      } catch (error) {
        return "写入文件失败：" + fileError(error);
      }
    },
  });
}
