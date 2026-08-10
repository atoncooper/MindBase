"use client";

/**
 * File inspector - right pane, Finder Preview-style.
 *
 * Shows the selected file's icon + name, action buttons (vectorize / delete),
 * a metadata table, ASR / vector status, and a content preview area. For
 * videos the preview comes from detail.asrPreview; for documents it is lazy-
 * loaded and paginated via getDocumentPreview.
 */
import { type ReactNode } from "react";
import Link from "next/link";
import {
    ArrowLeft,
    Trash2,
    Sparkles,
    Loader2,
    Eye,
} from "lucide-react";
import type { CloudVideoDetailResponse } from "@/lib/api/cloud";
import { formatBytes } from "@/lib/api/cloud";
import { FileIconTile } from "./file-icon";
import { AsrStatusBadge, VectorStatusBadge } from "./status-badges";
import { formatDuration, formatRelativeTime } from "./helpers";

interface FileInspectorProps {
    detail: CloudVideoDetailResponse;
    processing: boolean;
    onProcess: (uuid: string) => void;
    onDelete: (uuid: string) => void;
    onBack: () => void;
}

export function FileInspector({
    detail,
    processing,
    onProcess,
    onDelete,
    onBack,
}: FileInspectorProps) {
    const isVideo = detail.mimeType.startsWith("video/");
    const isVectorizable = detail.vectorStatus !== "not_supported";
    const done = detail.vectorStatus === "done";
    const inFlight = detail.vectorStatus === "processing" || processing;

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
                    详情
                </span>
                <button
                    type="button"
                    onClick={() => onDelete(detail.uploadUuid)}
                    title="删除"
                    aria-label="删除"
                    className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors hover:bg-danger/5 hover:text-danger"
                >
                    <Trash2 className="h-[18px] w-[18px]" />
                </button>
            </div>

            {/* Scroll body */}
            <div className="flex-1 overflow-y-auto px-4 pb-6">
                {/* Icon + name */}
                <div className="flex flex-col items-center pt-2 text-center">
                    <FileIconTile mimeType={detail.mimeType} size="lg" />
                    <p className="mt-3 line-clamp-2 text-[15px] font-semibold tracking-tight text-foreground">
                        {detail.title || detail.originalName}
                    </p>
                    <p className="mt-1 text-[11.5px] text-secondary" title={detail.originalName}>
                        {detail.originalName}
                    </p>
                </div>

                {/* Action */}
                <div className="mt-5 space-y-2">
                    {done ? (
                        <button
                            type="button"
                            onClick={() => onProcess(detail.uploadUuid)}
                            disabled={inFlight}
                            className="btn-pill btn-ghost h-9 w-full text-[13px]"
                        >
                            {inFlight ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Sparkles className="h-4 w-4" />
                            )}
                            重新入库
                        </button>
                    ) : isVectorizable ? (
                        <button
                            type="button"
                            onClick={() => onProcess(detail.uploadUuid)}
                            disabled={inFlight}
                            className="btn-pill btn-primary h-9 w-full text-[13px]"
                        >
                            {inFlight ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    入库中
                                </>
                            ) : (
                                <>
                                    <Sparkles className="h-4 w-4" />
                                    入库
                                </>
                            )}
                        </button>
                    ) : (
                        <div className="flex h-9 w-full items-center justify-center rounded-full bg-border-subtle text-[13px] text-tertiary">
                            不支持入库
                        </div>
                    )}

                    <Link
                        href={`/cloud-drive/${detail.uploadUuid}`}
                        className="btn-pill btn-ghost h-9 w-full text-[13px]"
                    >
                        <Eye className="h-4 w-4" />
                        查看
                    </Link>                </div>

                {/* Status */}
                <Section title="状态">
                    <Row label="转写">
                        {isVideo ? (
                            <AsrStatusBadge status={detail.asrStatus} />
                        ) : (
                            <span className="text-[12px] text-tertiary">无需转写</span>
                        )}
                    </Row>
                    <Row label="向量化">
                        <VectorStatusBadge status={detail.vectorStatus} />
                    </Row>
                    {detail.vectorChunkCount > 0 && (
                        <Row label="分块">
                            <span className="text-[12px] tabular-nums text-foreground">
                                {detail.vectorChunkCount}
                            </span>
                        </Row>
                    )}
                </Section>

                {/* Metadata */}
                <Section title="信息">
                    <Row label="大小">
                        <span className="text-[12px] tabular-nums text-foreground">
                            {formatBytes(detail.fileSize)}
                        </span>
                    </Row>
                    {detail.duration ? (
                        <Row label="时长">
                            <span className="text-[12px] tabular-nums text-foreground">
                                {formatDuration(detail.duration)}
                            </span>
                        </Row>
                    ) : null}
                    <Row label="类型">
                        <span className="max-w-[60%] truncate text-[12px] text-foreground">
                            {detail.mimeType}
                        </span>
                    </Row>
                    {detail.folderName && (
                        <Row label="文件夹">
                            <span className="truncate text-[12px] text-foreground">
                                {detail.folderName}
                            </span>
                        </Row>
                    )}
                    <Row label="添加时间">
                        <span className="text-[12px] text-foreground">
                            {formatRelativeTime(detail.createdAt)}
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
