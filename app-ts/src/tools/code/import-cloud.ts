import { z } from "zod";
import { defineTool } from "../base.js";
import type { CodeFilePort } from "./code-execution.js";
import type { ResearchExecutionGuard } from "./execution-guard.js";

const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

/** Minimal app-cloud M2M surface the import tool needs (keeps DI testable). */
export interface CloudFileSource {
  downloadFile(uid: string, uploadUuid: string): Promise<{ contentType: string; data: Uint8Array }>;
}

function extensionOf(contentType: string): string {
  const baseType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const map: Record<string, string> = {
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/csv": ".csv",
    "application/json": ".json",
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "application/zip": ".zip",
  };
  return map[baseType] ?? ".bin";
}

function safePrefix(raw: string | undefined): string {
  const prefix = (raw ?? "/workspace/analysis/data").trim();
  if (!prefix.startsWith("/workspace/")) {
    throw new Error("path_prefix 必须在 /workspace 下");
  }
  return prefix.replace(/\/+$/, "");
}

/** sandbox_import_cloud_files: copy user-selected cloud documents into /workspace. */
export function createSandboxImportCloudFilesTool(
  execution: CodeFilePort,
  cloud: CloudFileSource,
  guard?: ResearchExecutionGuard,
) {
  return defineTool({
    name: "sandbox_import_cloud_files",
    description:
      "把当前对话选中的云盘文件（scope.uploadUuids）导入沙箱 /workspace，供代码读取。" +
      "默认导入到 /workspace/analysis/data；单个文件上限 8MB；返回每个文件的沙箱路径。",
    inputSchema: z.object({
      path_prefix: z
        .string()
        .max(256)
        .optional()
        .describe("沙箱目录前缀，默认 /workspace/analysis/data，必须在 /workspace 下"),
      upload_uuid: z
        .string()
        .max(128)
        .optional()
        .describe("只导入指定云盘文件；省略则导入当前对话 scope 中的全部文件"),
    }),
    defaultTimeoutMs: 120_000,
    async execute(args, ctx, signal) {
      if (guard) {
        const blocked = await guard(ctx);
        if (blocked) return blocked;
      }
      if (!ctx.uid) return "导入失败：缺少用户身份";
      const prefix = safePrefix(args.path_prefix);
      const requested = args.upload_uuid
        ? [args.upload_uuid]
        : (ctx.scope.uploadUuids ?? []);
      if (requested.length === 0) {
        return "没有可导入的云盘文件：当前对话未选择云文档，也没有指定 upload_uuid。";
      }
      const results: string[] = [];
      for (const uploadUuid of requested) {
        if (signal?.aborted) return "导入已取消";
        try {
          const file = await cloud.downloadFile(ctx.uid, uploadUuid);
          if (file.data.byteLength > MAX_IMPORT_BYTES) {
            results.push(uploadUuid + ": 跳过（" + file.data.byteLength + " bytes，超过 8MB）");
            continue;
          }
          const path = prefix + "/" + uploadUuid + extensionOf(file.contentType);
          const base64 = Buffer.from(file.data).toString("base64");
          const written = await execution.writeFile(
            {
              path,
              content: base64,
              encoding: "base64",
              ...(ctx.academicProjectId ? { projectId: ctx.academicProjectId } : {}),
              purpose: "chat",
            },
            signal,
          );
          results.push(path + " (" + written.bytes + " bytes, " + file.contentType + ")");
        } catch (error) {
          results.push(uploadUuid + ": 失败（" + (error instanceof Error ? error.message : String(error)) + "）");
        }
      }
      return "云盘文件导入结果：\n" + results.map((line) => "- " + line).join("\n");
    },
  });
}
