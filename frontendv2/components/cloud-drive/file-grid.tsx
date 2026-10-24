"use client";

/**
 * File grid view - iCloud-Drive-style icon tiles.
 *
 * A responsive grid of tiles: large icon, 2-line-clipped name, size + status
 * dot beneath. Active tile = accent-soft surface + accent ring.
 *
 * cloud_refs 引用条目可与 files 混排（plan/1.0.16 §6）：带「引用」徽章、可删除；
 * dead → 「已失效」置灰，无预览活动入口。
 */
import { Loader2, ChevronDown, Trash2 } from "lucide-react";
import type { CloudVideoItem, RefItem } from "@/lib/api/cloud";
import { formatBytes } from "@/lib/api/cloud";
import { cn } from "@/lib/utils";
import { FileIconTile } from "./file-icon";
import { VectorStatusDotOnly } from "./status-badges";

interface FileGridProps {
    videos: CloudVideoItem[];
    selectedUuid: string | null;
    onSelect: (uuid: string) => void;
    hasMore: boolean;
    loadingMore: boolean;
    onLoadMore: () => void;
    /** 引用条目（可选，与 files 混排在网格尾部） */
    refs?: RefItem[];
    selectedRefId?: number | null;
    onSelectRef?: (id: number) => void;
    onDeleteRef?: (id: number) => void;
}

export function FileGrid({
    videos,
    selectedUuid,
    onSelect,
    hasMore,
    loadingMore,
    onLoadMore,
    refs,
    selectedRefId,
    onSelectRef,
    onDeleteRef,
}: FileGridProps) {
    return (
        <div className="p-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {videos.map((v) => {
                    const active = selectedUuid === v.uploadUuid;
                    return (
                        <button
                            key={v.uploadUuid}
                            type="button"
                            onClick={() => onSelect(v.uploadUuid)}
                            className={cn(
                                "flex flex-col items-center rounded-2xl border p-4 text-center transition-all",
                                active
                                    ? "border-accent/40 bg-accent-soft"
                                    : "border-transparent bg-surface hover:border-border hover:bg-border-subtle/40"
                            )}
                        >
                            <FileIconTile mimeType={v.mimeType} size="lg" />
                            <p
                                className={cn(
                                    "mt-3 line-clamp-2 min-h-[2.4em] text-[12.5px] leading-tight",
                                    active ? "font-medium text-accent" : "text-foreground"
                                )}
                                title={v.title || v.originalName}
                            >
                                {v.title || v.originalName}
                            </p>
                            <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-secondary">
                                <VectorStatusDotOnly status={v.vectorStatus} />
                                <span>{formatBytes(v.fileSize)}</span>
                            </p>
                        </button>
                    );
                })}
                {refs?.map((r) => {
                    const dead = r.status === "dead";
                    const active = !dead && selectedRefId === r.id;
                    const interactive = !dead && !!onSelectRef;
                    return (
                        <div
                            key={`ref-${r.id}`}
                            role={interactive ? "button" : undefined}
                            tabIndex={interactive ? 0 : undefined}
                            onClick={() => interactive && onSelectRef?.(r.id)}
                            onKeyDown={(e) => {
                                if (interactive && (e.key === "Enter" || e.key === " ")) {
                                    e.preventDefault();
                                    onSelectRef?.(r.id);
                                }
                            }}
                            className={cn(
                                "group relative flex flex-col items-center rounded-2xl border p-4 text-center transition-all",
                                interactive && "cursor-pointer",
                                active
                                    ? "border-accent/40 bg-accent-soft"
                                    : "border-transparent bg-surface hover:border-border hover:bg-border-subtle/40",
                                dead && "opacity-55",
                            )}
                        >
                            <FileIconTile mimeType={r.mimeType} size="lg" />
                            {onDeleteRef && (
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onDeleteRef(r.id);
                                    }}
                                    title="删除引用（不影响原文件）"
                                    aria-label={`删除引用 ${r.name}`}
                                    className="absolute right-1.5 top-1.5 rounded-full p-1 text-tertiary transition-colors hover:bg-danger/10 hover:text-danger"
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                </button>
                            )}
                            <p
                                className={cn(
                                    "mt-3 line-clamp-2 min-h-[2.4em] text-[12.5px] leading-tight",
                                    active ? "font-medium text-accent" : "text-foreground",
                                    dead && "text-tertiary",
                                )}
                                title={r.name}
                            >
                                {r.name}
                            </p>
                            <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-secondary">
                                <span
                                    className={cn(
                                        "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                                        dead ? "bg-border-subtle text-tertiary" : "bg-accent-soft text-accent",
                                    )}
                                >
                                    {dead ? "已失效" : "引用"}
                                </span>
                                <span>{formatBytes(r.size)}</span>
                            </p>
                        </div>
                    );
                })}
            </div>

            {hasMore && (
                <div className="flex justify-center pt-4 pb-1">
                    <button
                        type="button"
                        onClick={onLoadMore}
                        disabled={loadingMore}
                        className="flex items-center gap-1.5 rounded-full px-3.5 py-2.5 text-[12px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-50 md:py-1.5"
                    >
                        {loadingMore ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <ChevronDown className="h-3.5 w-3.5" />
                        )}
                        加载更多
                    </button>
                </div>
            )}
        </div>
    );
}
