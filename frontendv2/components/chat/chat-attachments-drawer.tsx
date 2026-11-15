"use client";

/**
 * ChatAttachmentsDrawer - 聊天输入区的附件抽屉（右侧覆盖层）。
 *
 * 输入框上方不再常驻图片缩略图与会话文件 chips：待发送图片和当前会话的文档
 * 统一收进这里（工具栏「附件 N」按钮打开）。图片可预览/移除；会话文件可下载/
 * 删除。Esc / 点击遮罩 / 关闭按钮收起；不做玻璃拟态/渐变，沿用浅色 token。
 */
import { useEffect } from "react";
import { Download, FileText, Images, Paperclip, Trash2, X } from "lucide-react";
import type { SessionDocument } from "@/lib/api";

function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + "MB";
    if (bytes >= 1024) return Math.round(bytes / 1024) + "KB";
    return bytes + "B";
}

export function ChatAttachmentsDrawer({
    open,
    onClose,
    images,
    onRemoveImage,
    sessionFiles,
    onDeleteSessionFile,
    onPreviewImage,
}: {
    open: boolean;
    onClose: () => void;
    /** 待随本条消息发送的图片（data URL） */
    images: string[];
    onRemoveImage: (index: number) => void;
    /** 当前会话已上传的文档（服务端解析切块、随会话检索） */
    sessionFiles: SessionDocument[];
    onDeleteSessionFile?: (doc: SessionDocument) => void;
    /** 打开图片大图预览（复用消息区的灯箱） */
    onPreviewImage?: (src: string) => void;
}) {
    // Esc 关闭（打开时监听，避免常驻全局键盘处理）。
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose]);

    if (!open) return null;

    const total = images.length + sessionFiles.length;

    return (
        <div className="fixed inset-0 z-[80]">
            <div
                className="absolute inset-0 bg-black/20"
                onClick={onClose}
                aria-hidden="true"
            />
            <aside
                role="dialog"
                aria-modal="true"
                aria-label={`附件 ${total}`}
                className="absolute right-0 top-0 flex h-full w-[380px] max-w-[92vw] flex-col border-l border-border bg-surface shadow-[-8px_0_30px_rgba(0,0,0,0.12)]"
            >
                <div className="flex items-center gap-2.5 border-b border-border-subtle px-4 py-3">
                    <Paperclip className="h-4 w-4 shrink-0 text-secondary" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium text-foreground">附件 {total}</div>
                        <div className="mt-0.5 text-[11px] text-tertiary">
                            待发送图片 {images.length} · 会话文件 {sessionFiles.length}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="关闭附件抽屉"
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground"
                    >
                        <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                    {total === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 text-center">
                            <div className="grid h-11 w-11 place-items-center rounded-full bg-border-subtle text-tertiary">
                                <Paperclip className="h-5 w-5" aria-hidden="true" />
                            </div>
                            <p className="mt-3 text-[13px] font-medium text-foreground">还没有附件</p>
                            <p className="mt-1 max-w-[260px] text-[12px] leading-relaxed text-secondary">
                                用输入栏左侧的按钮上传图片或文档：待发送图片会随下一条消息发出，文档上传后会加入当前会话检索。
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-5">
                            {images.length > 0 && (
                                <section aria-label="本次消息图片">
                                    <h3 className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-secondary">
                                        <Images className="h-3.5 w-3.5" aria-hidden="true" />
                                        本次消息图片
                                        <span className="text-tertiary">（{images.length}）</span>
                                    </h3>
                                    <div className="grid grid-cols-3 gap-2">
                                        {images.map((src, index) => (
                                            <div key={index} className="relative">
                                                <button
                                                    type="button"
                                                    onClick={() => onPreviewImage?.(src)}
                                                    className="block w-full overflow-hidden rounded-lg border border-border-subtle transition-opacity hover:opacity-90"
                                                    aria-label={`预览图片 ${index + 1}`}
                                                    title="点击预览大图"
                                                >
                                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                                    <img
                                                        src={src}
                                                        alt={`附件 ${index + 1}`}
                                                        className="h-24 w-full object-cover"
                                                    />
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => onRemoveImage(index)}
                                                    aria-label={`移除图片 ${index + 1}`}
                                                    className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-border bg-surface text-tertiary shadow-sm transition-colors hover:text-foreground"
                                                >
                                                    <X className="h-3 w-3" aria-hidden="true" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                </section>
                            )}

                            {sessionFiles.length > 0 && (
                                <section aria-label="会话文件">
                                    <h3 className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-secondary">
                                        <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                                        会话文件
                                        <span className="text-tertiary">（{sessionFiles.length}）</span>
                                    </h3>
                                    <ul className="space-y-2">
                                        {sessionFiles.map((doc) => (
                                            <li
                                                key={doc.id}
                                                className="flex items-center gap-2 rounded-xl border border-border-subtle px-2.5 py-2"
                                            >
                                                <FileText
                                                    className="h-4 w-4 shrink-0 text-tertiary"
                                                    aria-hidden="true"
                                                />
                                                <div className="min-w-0 flex-1">
                                                    {doc.download_url ? (
                                                        <a
                                                            href={doc.download_url}
                                                            download={doc.filename}
                                                            className="block truncate text-[12px] text-foreground underline-offset-2 transition-colors hover:text-accent hover:underline"
                                                            title="下载原始文件"
                                                        >
                                                            {doc.filename}
                                                        </a>
                                                    ) : (
                                                        <span className="block truncate text-[12px] text-foreground">
                                                            {doc.filename}
                                                        </span>
                                                    )}
                                                    <span className="text-[11px] text-tertiary">
                                                        {formatSize(doc.size_bytes)} · {doc.chunk_count} 段
                                                    </span>
                                                </div>
                                                {doc.download_url && (
                                                    <a
                                                        href={doc.download_url}
                                                        download={doc.filename}
                                                        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground"
                                                        aria-label={`下载 ${doc.filename}`}
                                                        title="下载原始文件"
                                                    >
                                                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                                                    </a>
                                                )}
                                                {onDeleteSessionFile && (
                                                    <button
                                                        type="button"
                                                        onClick={() => onDeleteSessionFile(doc)}
                                                        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-tertiary transition-colors hover:bg-danger/10 hover:text-danger"
                                                        aria-label={`移除文件 ${doc.filename}`}
                                                        title="从当前会话移除"
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                                    </button>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            )}
                        </div>
                    )}
                </div>

                <div className="border-t border-border-subtle px-4 py-2.5 text-[11px] leading-relaxed text-tertiary">
                    图片随本条消息发送；会话文件在当前会话内可被检索，发送消息后仍保留。
                </div>
            </aside>
        </div>
    );
}
