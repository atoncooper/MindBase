/**
 * Typed access to the exports listing (`exports_list` on the Rust side).
 *
 * 生成记录：对话工具（generate_resume / generate_slides）产出的文件都落在
 * 数据目录的 exports/ 下，这里按修改时间倒序列出供入口页展示。
 */

import { invoke } from "@tauri-apps/api/core";

export interface ExportEntry {
  name: string;
  path: string;
  /** "markdown" | "pptx" | raw extension for anything else. */
  kind: string;
  sizeBytes: number;
  /** File mtime, epoch seconds. */
  modifiedAt: number;
}

/** List generated artifacts, newest first. */
export function listExports(): Promise<ExportEntry[]> {
  return invoke<ExportEntry[]>("exports_list");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
