"use client";

/**
 * File grid view - iCloud-Drive-style icon tiles.
 *
 * A responsive grid of tiles: large icon, 2-line-clipped name, size + status
 * dot beneath. Active tile = accent-soft surface + accent ring.
 */
import { Loader2, ChevronDown } from "lucide-react";
import type { CloudVideoItem } from "@/lib/api/cloud";
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
}

export function FileGrid({
    videos,
    selectedUuid,
    onSelect,
    hasMore,
    loadingMore,
    onLoadMore,
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
            </div>

            {hasMore && (
                <div className="flex justify-center pt-4 pb-1">
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
