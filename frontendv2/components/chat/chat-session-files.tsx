"use client";

import { X, FileText } from "lucide-react";
import type { SessionDocument } from "@/lib/api";

// 当前会话上传文件的 chips 列表:名称 · 大小 · 切块数 + 下载/删除。
// 渲染在输入框上方(与技能 chips 同层);无文件时不占位。
// 文件名在存了原始二进制时是下载链接(MinIO 预签名,经 nginx /minio-proxy/)。
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + "MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + "KB";
  return bytes + "B";
}

export function ChatSessionFiles({
  files,
  onDelete,
}: {
  files: SessionDocument[];
  onDelete: (doc: SessionDocument) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5" role="list" aria-label="当前会话文件">
      {files.map((f) => (
        <span
          key={f.id}
          role="listitem"
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-[12px] text-foreground"
          title={f.filename + " · " + formatSize(f.size_bytes) + " · 切成 " + f.chunk_count + " 段"}
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-tertiary" aria-hidden="true" />
          {f.download_url ? (
            <a
              href={f.download_url}
              download={f.filename}
              className="truncate underline-offset-2 transition-colors hover:text-accent hover:underline"
              title="下载原始文件"
            >
              {f.filename}
            </a>
          ) : (
            <span className="truncate">{f.filename}</span>
          )}
          <span className="shrink-0 text-tertiary">
            {formatSize(f.size_bytes)} · {f.chunk_count}段
          </span>
          <button
            type="button"
            onClick={() => onDelete(f)}
            className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground"
            aria-label={"移除文件 " + f.filename}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}