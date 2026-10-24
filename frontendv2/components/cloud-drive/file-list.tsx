"use client";

/**
 * File list view - Finder-style rows.
 *
 * Each row: icon tile + name (with size/duration/modified subtext) + vector
 * status dot. Active row = accent-soft + a left accent hairline. A load-more
 * affordance appears at the bottom when more pages are available.
 *
 * cloud_refs 引用条目（plan/1.0.16 §6）可与 files 混排：带「引用」徽章、可删除；
 * status=dead → 「已失效」置灰，不给预览等活动入口（仅保留删除清理）。
 */
import { Loader2, ChevronDown, Trash2 } from "lucide-react";
import type { CloudVideoItem, RefItem } from "@/lib/api/cloud";
import { formatBytes } from "@/lib/api/cloud";
import { cn } from "@/lib/utils";
import { FileIconTile } from "./file-icon";
import { VectorStatusDotOnly } from "./status-badges";
import { formatDuration, formatRelativeTime } from "./helpers";

interface FileListProps {
    videos: CloudVideoItem[];
    selectedUuid: string | null;
    onSelect: (uuid: string) => void;
    hasMore: boolean;
    loadingMore: boolean;
    onLoadMore: () => void;
    /** 引用条目（可选，与 files 混排在列表尾部） */
    refs?: RefItem[];
    selectedRefId?: number | null;
    onSelectRef?: (id: number) => void;
    onDeleteRef?: (id: number) => void;
}

export function FileList({
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
}: FileListProps) {
    return (
        <div className="p-3">
            <ul className="space-y-0.5">
                {videos.map((v) => {
                    const active = selectedUuid === v.uploadUuid;
                    return (
                        <li key={v.uploadUuid} className="relative">
                            {active && (
                                <span className="absolute left-0 top-1/2 h-6 w-[2.5px] -translate-y-1/2 rounded-full bg-accent" />
                            )}
                            <button
                                type="button"
                                onClick={() => onSelect(v.uploadUuid)}
                                className={cn(
                                    "flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors",
                                    active
                                        ? "bg-accent-soft"
                                        : "hover:bg-border-subtle/70"
                                )}
                            >
                                <FileIconTile mimeType={v.mimeType} size="sm" />
                                <div className="min-w-0 flex-1">
                                    <p
                                        className={cn(
                                            "truncate text-[13.5px]",
                                            active
                                                ? "font-medium text-accent"
                                                : "text-foreground"
                                        )}
                                    >
                                        {v.title || v.originalName}
                                    </p>
                                    <p className="mt-0.5 truncate text-[11.5px] text-secondary">
                                        <span>{formatBytes(v.fileSize)}</span>
                                        {v.duration ? (
                                            <>
                                                <span className="mx-1.5 text-tertiary">·</span>
                                                <span>{formatDuration(v.duration)}</span>
                                            </>
                                        ) : null}
                                        <span className="mx-1.5 text-tertiary">·</span>
                                        <span>{formatRelativeTime(v.createdAt)}</span>
                                    </p>
                                </div>
                                <span className="hidden shrink-0 items-center sm:flex">
                                    <VectorStatusDotOnly status={v.vectorStatus} />
                                </span>
                            </button>
                        </li>
                    );
                })}
                {refs?.map((r) => {
                    const dead = r.status === "dead";
                    const active = !dead && selectedRefId === r.id;
                    const interactive = !dead && !!onSelectRef;
                    return (
                        <li key={`ref-${r.id}`} className="relative">
                            {active && (
                                <span className="absolute left-0 top-1/2 h-6 w-[2.5px] -translate-y-1/2 rounded-full bg-accent" />
                            )}
                            <div
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
                                    "group flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors",
                                    interactive && "cursor-pointer hover:bg-border-subtle/70",
                                    active ? "bg-accent-soft" : dead ? "opacity-55" : "hover:bg-border-subtle/70",
                                )}
                            >
                                <FileIconTile mimeType={r.mimeType} size="sm" />
                                <div className="min-w-0 flex-1">
                                    <p className="flex items-center gap-1.5">
                                        <span
                                            className={cn(
                                                "truncate text-[13.5px]",
                                                active ? "font-medium text-accent" : "text-foreground",
                                                dead && "text-tertiary",
                                            )}
                                        >
                                            {r.name}
                                        </span>
                                        <span
                                            className={cn(
                                                "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                                                dead
                                                    ? "bg-border-subtle text-tertiary"
                                                    : "bg-accent-soft text-accent",
                                            )}
                                        >
                                            {dead ? "已失效" : "引用"}
                                        </span>
                                    </p>
                                    <p className="mt-0.5 truncate text-[11.5px] text-secondary">
                                        <span>{formatBytes(r.size)}</span>
                                        <span className="mx-1.5 text-tertiary">·</span>
                                        <span>{formatRelativeTime(r.createdAt)}</span>
                                    </p>
                                </div>
                                {onDeleteRef && (
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onDeleteRef(r.id);
                                        }}
                                        title="删除引用（不影响原文件）"
                                        aria-label={`删除引用 ${r.name}`}
                                        className="shrink-0 rounded-full p-1.5 text-tertiary transition-colors hover:bg-danger/10 hover:text-danger"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                )}
                            </div>
                        </li>
                    );
                })}
            </ul>

            {hasMore && (
                <div className="flex justify-center pt-3 pb-1">
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
