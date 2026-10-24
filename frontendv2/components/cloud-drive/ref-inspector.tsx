"use client";

/**
 * RefInspector - right-pane details for a cloud_ref 引用条目 (plan/1.0.16 §6).
 *
 * 引用没有 upload/ASR/vector 状态（不进上传/转写/入库流程），只提供：
 * 预览（跳转 /cloud-drive/refs/[id] 走 rawRefFile presign）/ 删除引用。
 * status=dead（原文件删除 / 来源分享被封禁等）→ 无活动入口，仅提示 + 可删除。
 */
import { type ReactNode } from "react";
import { ArrowLeft, Eye, Trash2, Ban } from "lucide-react";
import type { RefItem } from "@/lib/api/cloud";
import { formatBytes } from "@/lib/api/cloud";
import { FileIconTile } from "./file-icon";
import { formatRelativeTime } from "./helpers";
import { cn } from "@/lib/utils";

interface RefInspectorProps {
    refItem: RefItem;
    onPreview: (id: number) => void;
    onDelete: (id: number) => void;
    onBack: () => void;
}

export function RefInspector({ refItem, onPreview, onDelete, onBack }: RefInspectorProps) {
    const dead = refItem.status === "dead";

    return (
        <div className="flex h-full w-full flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3">
                <button
                    type="button"
                    onClick={onBack}
                    title="返回"
                    aria-label="返回"
                    className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground lg:hidden"
                >
                    <ArrowLeft className="h-4 w-4" />
                </button>
                <span className="text-[13px] font-semibold text-foreground md:ml-0 ml-auto">
                    引用详情
                </span>
                <button
                    type="button"
                    onClick={() => onDelete(refItem.id)}
                    title="删除引用（不影响原文件）"
                    aria-label="删除引用"
                    className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors hover:bg-danger/5 hover:text-danger"
                >
                    <Trash2 className="h-[18px] w-[18px]" />
                </button>
            </div>

            {/* Scroll body */}
            <div className="flex-1 overflow-y-auto px-4 pb-6">
                {/* Icon + name */}
                <div className="flex flex-col items-center pt-2 text-center">
                    <FileIconTile mimeType={refItem.mimeType} size="lg" />
                    <p className="mt-3 line-clamp-2 text-[15px] font-semibold tracking-tight text-foreground">
                        {refItem.name}
                    </p>
                    <span
                        className={cn(
                            "mt-2 rounded-full px-2 py-0.5 text-[11px] font-medium",
                            dead ? "bg-border-subtle text-tertiary" : "bg-accent-soft text-accent",
                        )}
                    >
                        {dead ? "已失效" : "引用 · 不占用云盘空间"}
                    </span>
                </div>

                {/* Action */}
                <div className="mt-5 space-y-2">
                    {dead ? (
                        <div className="flex h-11 w-full items-center justify-center gap-1.5 rounded-full bg-border-subtle text-[13px] text-tertiary md:h-9">
                            <Ban className="h-3.5 w-3.5" />
                            原文件或来源分享已失效
                        </div>
                    ) : (
                        <button
                            type="button"
                            onClick={() => onPreview(refItem.id)}
                            className="btn-pill btn-primary h-11 w-full text-[13px] md:h-9"
                        >
                            <Eye className="h-4 w-4" />
                            预览
                        </button>
                    )}
                </div>

                {/* Metadata */}
                <Section title="信息">
                    <Row label="大小">
                        <span className="text-[12px] tabular-nums text-foreground">
                            {formatBytes(refItem.size)}
                        </span>
                    </Row>
                    <Row label="类型">
                        <span className="max-w-[60%] truncate text-[12px] text-foreground">
                            {refItem.mimeType}
                        </span>
                    </Row>
                    {refItem.sourceName && refItem.sourceName !== refItem.name && (
                        <Row label="原文件名">
                            <span className="max-w-[60%] truncate text-[12px] text-foreground" title={refItem.sourceName}>
                                {refItem.sourceName}
                            </span>
                        </Row>
                    )}
                    <Row label="保存时间">
                        <span className="text-[12px] text-foreground">
                            {formatRelativeTime(refItem.createdAt)}
                        </span>
                    </Row>
                    <Row label="存储">
                        <span className="text-[12px] text-tertiary">
                            引用（指向原文件，不占配额）
                        </span>
                    </Row>
                </Section>
            </div>
        </div>
    );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="mt-6">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-tertiary">
                {title}
            </h3>
            <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface px-3">
                {children}
            </div>
        </div>
    );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-3 py-2">
            <span className="text-[12px] text-secondary">{label}</span>
            <span className="min-w-0 text-right">{children}</span>
        </div>
    );
}
