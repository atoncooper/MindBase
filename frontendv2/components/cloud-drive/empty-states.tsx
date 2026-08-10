"use client";

/**
 * Cloud drive empty / loading states.
 *
 * Follows the frontendv2 pattern: centered icon tile + title + description +
 * optional primary CTA. Skeletons use animate-pulse on border-subtle blocks.
 */
import { CloudUpload, FolderOpen, Inbox, Loader2 } from "lucide-react";

export function EmptyFolder({ onUpload }: { onUpload?: () => void }) {
    return (
        <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-border-subtle text-secondary">
                <FolderOpen className="h-6 w-6" />
            </span>
            <p className="mt-4 text-[15px] font-medium text-foreground">这个文件夹是空的</p>
            <p className="mt-1.5 max-w-xs text-[13px] text-secondary">
                拖拽文件到此处置入云盘，或点击上传。支持视频、PDF、Markdown、文档等。
            </p>
            {onUpload && (
                <button
                    type="button"
                    onClick={onUpload}
                    className="btn-pill btn-primary mt-6 h-9 px-5 text-[13px]"
                >
                    <CloudUpload className="h-4 w-4" />
                    上传文件
                </button>
            )}
        </div>
    );
}

export function NoFiles() {
    return (
        <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-border-subtle text-secondary">
                <Inbox className="h-6 w-6" />
            </span>
            <p className="mt-4 text-[15px] font-medium text-foreground">还没有文件</p>
            <p className="mt-1.5 max-w-xs text-[13px] text-secondary">
                上传的视频与文档会显示在这里，入库后即可用于对话检索。
            </p>
        </div>
    );
}

export function FileListSkeleton({ rows = 7 }: { rows?: number }) {
    return (
        <div className="space-y-1.5 p-4">
            {Array.from({ length: rows }).map((_, i) => (
                <div
                    key={i}
                    className="flex items-center gap-3 rounded-[10px] px-2.5 py-2.5"
                >
                    <div className="h-10 w-10 shrink-0 animate-pulse rounded-xl bg-border-subtle" />
                    <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="h-3.5 w-2/3 animate-pulse rounded bg-border-subtle" />
                        <div className="h-3 w-1/4 animate-pulse rounded bg-border-subtle" />
                    </div>
                    <div className="h-3 w-16 animate-pulse rounded bg-border-subtle" />
                </div>
            ))}
        </div>
    );
}

export function FullPageLoader() {
    return (
        <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-tertiary" />
        </div>
    );
}
