"use client";

/**
 * File list view - Finder-style rows.
 *
 * Each row: icon tile + name (with size/duration/modified subtext) + vector
 * status dot. Active row = accent-soft + a left accent hairline. A load-more
 * affordance appears at the bottom when more pages are available.
 */
import { Loader2, ChevronDown } from "lucide-react";
import type { CloudVideoItem } from "@/lib/api/cloud";
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
}

export function FileList({
    videos,
    selectedUuid,
    onSelect,
    hasMore,
    loadingMore,
    onLoadMore,
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
            </ul>

            {hasMore && (
                <div className="flex justify-center pt-3 pb-1">
                    <button
                        type="button"
                        onClick={onLoadMore}
                        disabled={loadingMore}
                        className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-50"
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
